import { createCipheriv, createECDH, createHash, ECDH, hkdfSync, randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { connect as tlsConnect } from "node:tls"
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { clip, fallback, type Notification, type Status } from "./notification.js"

export type Payload = Notification & { sessionID: string; status: Status }
export type PairInput = { callbackURL: string; ref: string; publicKey: string }

export const MobileNotifications = Rpc.define({
  id: "mobile-notifications",
  methods: {
    pair: {
      input: {
        type: "object",
        properties: { callbackURL: { type: "string" }, ref: { type: "string" }, publicKey: { type: "string" } },
        required: ["callbackURL", "ref", "publicKey"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { publicKey: { type: "string" } },
        required: ["publicKey"],
        additionalProperties: false,
      },
      errors: { pairing_failed: { type: "object", additionalProperties: false } },
    },
  },
  events: {},
})

export const DEFAULT_RELAY_ORIGINS = ["https://opencode-notify-relay.anomalyco.workers.dev"]
const PREFIX = "encryption:v2:"
const TTL_MS = 30 * 24 * 60 * 60_000
const MAX_BINDINGS = 256
const INFO = "OpenCode mobile notifications v2"
const MAX_PLAINTEXT_BYTES = 2700 - 12 - 16
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Outside PREFIX, so the binding scan never removes them as malformed bindings.
const CALLBACK_PREFIX = "callback:v2:" // callback URL hash → the phone it was paired for
const DEVICE_PREFIX = "device:v2:" // phone (ref + public key) hash → its newest callback
// Outlives a callback, for an Always Notify session that stays quiet across a renewal.
const FOLLOW_TTL_MS = 3 * TTL_MS
const MAX_FOLLOWED = 1024

type Binding = Omit<PairInput, "callbackURL"> & { serverPublicKey: string; key: string; createdAt: number }
type Seen = { device: string; createdAt: number }
type Latest = { url: string; createdAt: number }
type Storage = Plugin.Context["storage"]

// KV has no compare-and-swap. All locations/reloads in this server process share this queue;
// the read, conflict check and durable write must be one critical section, not just key generation.
const enrollment = ((globalThis as { __opencodeNotifyEnrollmentV2?: { tail: Promise<unknown> } })
  .__opencodeNotifyEnrollmentV2 ??= { tail: Promise.resolve() })

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function bindingKey(url: string) {
  return PREFIX + digest(url)
}

function fresh<T extends { createdAt: number }>(value: unknown, now: number): value is T {
  const createdAt = (value as Partial<T> | undefined)?.createdAt
  return typeof createdAt === "number" && Number.isFinite(createdAt) && now - createdAt < FOLLOW_TTL_MS
}

/** Drop expired follow records and keep the newest MAX_FOLLOWED - 1, before writing a key that isn't stored yet. */
async function prune(storage: Storage, prefix: string, now: number) {
  const live: { key: string; createdAt: number }[] = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix, after, limit: 100 })
    for (const entry of page.entries) {
      if (fresh<{ createdAt: number }>(entry.value, now)) live.push({ key: entry.key, createdAt: entry.value.createdAt })
      else await storage.remove(entry.key)
    }
    after = page.next
  } while (after)
  live.sort((a, b) => a.createdAt - b.createdAt)
  for (const old of live.slice(0, Math.max(0, live.length - MAX_FOLLOWED + 1))) await storage.remove(old.key)
}

function publicKey(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("Invalid notification public key")
  const bytes = Buffer.from(value, "base64")
  if (bytes.length !== 65 || bytes[0] !== 4 || bytes.toString("base64") !== value)
    throw new Error("Invalid notification public key")
  // Also rejects off-curve points, not just invalid encodings.
  ECDH.convertKey(bytes, "prime256v1")
  return bytes
}

function binding(value: unknown): Binding | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Binding
  if (typeof row.ref !== "string" || !REF.test(row.ref) ||
      typeof row.publicKey !== "string" || typeof row.serverPublicKey !== "string" ||
      typeof row.key !== "string" || typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return undefined
  return row
}

/** Keep the existing lock-screen limits and check the final UTF-8 JSON size before sealing. */
function plaintext(payload: Payload): Buffer {
  if (typeof payload.sessionID !== "string" || !/^ses[A-Za-z0-9_]{1,197}$/.test(payload.sessionID) ||
      !["succeeded", "failed", "interrupted"].includes(payload.status)) throw new Error("Invalid notification payload")
  const defaults = fallback(payload.status, undefined, { title: 80, body: 300 })
  const title = clip(payload.title, 80) || defaults.title
  const body = clip(payload.body, 300) || defaults.body
  const result = Buffer.from(JSON.stringify({ title, body, sessionID: payload.sessionID, status: payload.status }))
  if (result.length > MAX_PLAINTEXT_BYTES) throw new Error("Notification exceeds payload limit")
  return result
}

/** The single enrollment and delivery boundary, also usable by integration/interop checks. */
export function createNotificationSender(options: {
  storage: Storage
  relayOrigins?: ReadonlySet<string>
  allowHTTP?: boolean
  signal?: AbortSignal
  encryptionEnabled?: () => boolean
}) {
  const origins = options.relayOrigins ?? new Set(DEFAULT_RELAY_ORIGINS)
  const accept = (value: unknown): string | undefined => {
    if (typeof value !== "string" || value.length > 4096) return undefined
    try {
      const url = new URL(value)
      const scheme = url.protocol === "https:" || (options.allowHTTP && url.protocol === "http:")
      // Reject query/fragment, traversal, alternate encodings, credentials and extra path segments.
      if (scheme && !url.username && !url.password && !url.search && !url.hash &&
          origins.has(url.origin) && /^\/v[12]\/notify\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
          url.toString() === value && value === url.origin + url.pathname) return value
    } catch {}
    return undefined
  }

  /**
   * Note which phone a callback (by URL hash) was first paired for. A callback belongs to that phone for good:
   * an expired one re-paired for another phone is never followed. Returns the callback's first pairing time.
   */
  const note = async (urlHash: string, device: string, createdAt: number, now: number): Promise<number | undefined> => {
    const key = CALLBACK_PREFIX + urlHash
    const seen = await options.storage.get(key)
    if (fresh<Seen>(seen, now) && typeof seen.device === "string") return seen.device === device ? seen.createdAt : undefined
    await prune(options.storage, CALLBACK_PREFIX, now)
    await options.storage.set(key, { device, createdAt } satisfies Seen)
    return createdAt
  }

  /** Make `url` the callback `current` follows for its phone, unless that phone already paired a newer one. */
  const remember = async (url: string, row: Binding, now: number) => {
    try {
      const device = digest(`${row.ref}:${row.publicKey}`)
      const known = fresh<Seen>(await options.storage.get(CALLBACK_PREFIX + digest(url)), now)
      const age = await note(digest(url), device, row.createdAt, now)
      if (age === undefined) return
      const key = DEVICE_PREFIX + device
      const latest = await options.storage.get(key)
      if (fresh<Latest>(latest, now)) {
        if (latest.url === url) return
        // A tie goes to a callback paired for the first time, never to a retry of an older one.
        if (age < latest.createdAt || (age === latest.createdAt && known)) return
      } else {
        await prune(options.storage, DEVICE_PREFIX, now)
      }
      await options.storage.set(key, { url, createdAt: age } satisfies Latest)
    } catch {
      // Best effort: the pairing itself is already durable.
    }
  }

  /**
   * The newest callback the phone behind `url` has paired. Callbacks expire, and an Always Notify session keeps
   * the URL it was given, so its alerts follow its phone (same ref and public key) to the renewed one.
   */
  const current = async (url: string): Promise<string> => {
    try {
      const now = Date.now()
      const seen = await options.storage.get(CALLBACK_PREFIX + digest(url))
      if (!fresh<Seen>(seen, now) || typeof seen.device !== "string") return url
      const latest = await options.storage.get(DEVICE_PREFIX + seen.device)
      if (!fresh<Latest>(latest, now) || latest.createdAt < seen.createdAt || latest.url === url || !accept(latest.url)) return url
      const row = binding(await options.storage.get(bindingKey(latest.url)))
      return row && now - row.createdAt < TTL_MS && digest(`${row.ref}:${row.publicKey}`) === seen.device ? latest.url : url
    } catch {
      return url
    }
  }

  const pair = (input: unknown): Promise<{ publicKey: string }> => {
    const task = enrollment.tail.then(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid notification enrollment")
      const { callbackURL, ref, publicKey: phoneKey } = input as PairInput
      if (!accept(callbackURL) || !callbackURL.startsWith("https:") || new URL(callbackURL).pathname.split("/")[1] !== "v2" ||
          typeof ref !== "string" || !REF.test(ref)) throw new Error("Invalid notification enrollment")
      const phoneBytes = publicKey(phoneKey)
      const now = Date.now()
      const id = bindingKey(callbackURL)
      const existing = binding(await options.storage.get(id))
      if (existing && now - existing.createdAt < TTL_MS) {
        if (existing.ref !== ref || existing.publicKey !== phoneKey) throw new Error("Notification enrollment conflict")
        // Re-pairs also record bindings made before callbacks were followed.
        await remember(callbackURL, existing, now)
        return { publicKey: existing.serverPublicKey }
      }
      const rows: Binding[] = []
      /** This phone's other callbacks, by URL hash (expired ones too: a quiet session may still hold one). */
      const mine: { hash: string; createdAt: number }[] = []
      let after: string | undefined
      do {
        const page = await options.storage.scan({ prefix: PREFIX, after, limit: 100 })
        for (const entry of page.entries) {
          const row = binding(entry.value)
          // Fixed lifetime: retries never extend a callback beyond the relay's maximum lifetime.
          if (row && row.ref === ref && row.publicKey === phoneKey) mine.push({ hash: entry.key.slice(PREFIX.length), createdAt: row.createdAt })
          if (!row || now - row.createdAt >= TTL_MS) await options.storage.remove(entry.key)
          else rows.push(row)
        }
        after = page.next
      } while (after)
      if (rows.length >= MAX_BINDINGS) throw new Error("Notification enrollment capacity reached")
      // Reuse a pairing across callback renewals, not across devices. A restored phone
      // can have the old ref but a new device-only key; its new URL is a separate binding.
      const sameDevice = rows.find((row) => row.ref === ref && row.publicKey === phoneKey)
      let serverPublicKey = sameDevice?.serverPublicKey
      let key = sameDevice?.key
      if (!serverPublicKey || !key) {
        const server = createECDH("prime256v1")
        serverPublicKey = server.generateKeys().toString("base64")
        key = Buffer.from(hkdfSync("sha256", server.computeSecret(phoneBytes), Buffer.from(ref), Buffer.from(INFO), 32)).toString("base64")
      }
      // No memory fallback: a successful enrollment guarantees durable key material for reloads.
      const row: Binding = { ref, publicKey: phoneKey, serverPublicKey, key, createdAt: now }
      await options.storage.set(id, row)
      // Callbacks paired before they were followed: note them, so a session holding one follows this renewal.
      const device = digest(`${ref}:${phoneKey}`)
      for (const old of mine) await note(old.hash, device, old.createdAt, now).catch(() => undefined)
      await remember(callbackURL, row, now)
      return { publicKey: serverPublicKey }
    })
    enrollment.tail = task.catch(() => undefined)
    return task
  }

  const post = async (url: string, payload: Payload): Promise<{ sent: boolean; preview?: boolean; status?: number }> => {
    if (!accept(url)) return { sent: false }
    let body = "{}"
    if (new URL(url).pathname.startsWith("/v2/") && (options.encryptionEnabled?.() ?? true)) {
      try {
        const row = binding(await options.storage.get(bindingKey(url)))
        if (row && Date.now() - row.createdAt < TTL_MS) {
          const key = Buffer.from(row.key, "base64")
          if (key.length !== 32 || key.toString("base64") !== row.key) throw new Error("Invalid notification key")
          const nonce = randomBytes(12)
          const cipher = createCipheriv("aes-256-gcm", key, nonce)
          cipher.setAAD(Buffer.from(INFO + ":" + row.ref))
          const ciphertext = Buffer.concat([cipher.update(plaintext(payload)), cipher.final()])
          body = JSON.stringify({ box: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64") })
        }
      } catch {
        // Encryption/storage failure must never fall back to sending session content or identifiers.
      }
    }
    try {
      const response = await postViaProxy(url, body, options.signal)
      return { sent: response.ok, preview: body !== "{}", status: response.status }
    } catch {
      return { sent: false }
    }
  }

  return { accept, current, pair, post }
}

/**
 * POST through the local proxy by default.
 *
 * Bun's global `fetch` does not consistently honour HTTPS_PROXY, and on a filtered network the relay's DNS
 * answers are poisoned or its IPs are reset, so a direct fetch never reaches it. Routing explicitly through the
 * local proxy keeps notifications working without changing how the server process is launched.
 *
 * `OPENCODE_NOTIFY_PROXY` overrides the proxy; an empty value or `direct` bypasses it.
 */
const DEFAULT_PROXY = "http://127.0.0.1:7890"

type Response = { ok: boolean; status: number }

function proxyURL(): URL | undefined {
  const raw = (process.env.OPENCODE_NOTIFY_PROXY ?? DEFAULT_PROXY).trim()
  if (!raw || raw === "direct" || raw === "none") return undefined
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

/** Split `http://127.0.0.1:7890` into the host and port to open a CONNECT tunnel to. */
function proxyEndpoint(proxy: URL): { host: string; port: number } {
  return { host: proxy.hostname, port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80) }
}

function postViaProxy(url: string, body: string, signal?: AbortSignal): Promise<Response> {
  const target = new URL(url)
  const proxy = proxyURL()
  if (!proxy) return directPost(target, body, signal)
  const { host, port } = proxyEndpoint(proxy)
  return new Promise<Response>((resolve, reject) => {
    // Authenticate to the proxy only if it was configured with credentials.
    const auth =
      proxy.username || proxy.password
        ? `Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64")}`
        : undefined
    const connect = httpRequest({
      host,
      port,
      method: "CONNECT",
      path: `${target.hostname}:${Number(target.port) || 443}`,
      headers: auth ? { host: `${target.hostname}:${Number(target.port) || 443}`, "proxy-authorization": auth } : { host: `${target.hostname}:${Number(target.port) || 443}` },
      signal,
    })
    connect.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        // A refused tunnel is a failed send, not a crash: reuse the status when the proxy gave one.
        reject(new Error(`Proxy CONNECT failed with ${response.statusCode}`))
        return
      }
      const secured = tlsConnect({ socket, servername: target.hostname }, () => {
        const headers = [
          `POST ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          "content-type: application/json",
          `content-length: ${Buffer.byteLength(body)}`,
          "connection: close",
          "",
          "",
        ].join("\r\n")
        secured.write(headers)
        secured.write(body)
      })
      let raw = ""
      secured.setEncoding("utf8")
      secured.on("data", (chunk) => {
        raw += chunk
      })
      secured.on("end", () => {
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0)
        resolve({ ok: status >= 200 && status < 300, status })
      })
      secured.on("error", reject)
    })
    connect.on("error", reject)
    connect.end()
  })
}

function directPost(target: URL, body: string, signal?: AbortSignal): Promise<Response> {
  return fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
  }).then((response) => ({ ok: response.ok, status: response.status }))
}
