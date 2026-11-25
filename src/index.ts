/**
 * Per-prompt completion callbacks.
 *
 * Send a prompt with `metadata: { notification: { callbackURL: "https://…" } }`. When that session's run
 * ends, the plugin asks the session's own model (via `session.generate`, reusing its prompt cache) for a
 * short notification and POSTs an encrypted box to the URL once. Generation failures send a fallback.
 * Title, body, session ID and status are encrypted for the paired phone; unpaired/legacy callbacks receive {}.
 *
 * A session whose metadata has `notification: { always: true, callbackURL }` (the app's Always Notify switch)
 * notifies when any of its runs ends, not only runs prompted from the phone, as long as a message arrived for it
 * (a run only a background shell or subagent finishing woke stays quiet) and, when it succeeded, the model says
 * its reply tells the user something (routine housekeeping stays quiet). Subagents, which inherit their parent's
 * metadata, never notify. Callbacks expire after 30 days and the session keeps the one it was given, so its alerts
 * follow the newest callback the same phone has paired, which is then saved to the session.
 *
 * It also gives agents a `notify_phone` tool: a custom title and body sent to the same phone, through the same
 * callback, for a session (or its parent) whose prompt came from the phone. A run that sent one skips its own
 * "finished" notification.
 *
 * Callbacks live in plugin storage, so a reload or restart mid-run doesn't lose them. A session's phone callback
 * is forgotten after 30 days, or as soon as the relay says it's gone (HTTP 410).
 *
 * Options: `relayOrigins` (default `["https://opencode-notify-relay.anomalyco.workers.dev"]`; a callback URL must
 * have one of these origins and an exact `/v1/notify/:sealed` or `/v2/notify/:sealed` path), `allowHTTP` (default false; for local relays listed in
 * `relayOrigins`), `generate` (default true), `timeoutMs` (default 30000), `titleLimit` (default 40),
 * `bodyLimit` (default 140), `tool` (default true).
 */
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { clip, defaultLimits, fallback, parse, prompt, type Limits, type Notification, type Status } from "./notification.js"
import { createNotificationSender, DEFAULT_RELAY_ORIGINS, MobileNotifications } from "./encryption.js"
export type { Payload } from "./encryption.js"

type Pending = { url: string; inboxID: string }
type SessionLike = { parentID?: string; metadata?: Record<string, unknown> } | undefined
/** A session's latest phone callback. Older versions stored the URL as a plain string. */
type Phone = { url: string; savedAt: number }

const PHONE_TTL_MS = 30 * 24 * 60 * 60_000

const warn = (message: string) => console.warn(`[opencode-notify-callback] ${message}`)

/**
 * State every copy of this plugin in the server process shares. A reload or update can leave an earlier copy
 * listening beside the new one, and each copy sees every event: without one claim per event, each sent its
 * own notification for the same run.
 */
type Shared = { claims: Map<string, number>; messaged: Set<string>; memory: Map<string, unknown> }
const shared: Shared = ((globalThis as { __opencodeNotifyCallback?: Shared }).__opencodeNotifyCallback ??= {
  claims: new Map(),
  messaged: new Set(),
  memory: new Map(),
})
/** True for the first caller per key; synchronous, so no other copy can interleave. */
const claim = (key: string) => {
  const now = Date.now()
  for (const [old, at] of shared.claims) if (now - at > 10 * 60_000) shared.claims.delete(old)
  if (shared.claims.has(key)) return false
  shared.claims.set(key, now)
  return true
}

export default Plugin.define({
  id: "opencode-notify-callback",
  async setup(ctx) {
    const options = ctx.options as Record<string, unknown>
    const allowHTTP = options.allowHTTP === true
    const relayOrigins = new Set(
      (Array.isArray(options.relayOrigins) ? options.relayOrigins : DEFAULT_RELAY_ORIGINS).flatMap((value: unknown) => {
        try {
          return typeof value === "string" ? [new URL(value).origin] : []
        } catch {
          return []
        }
      }),
    )
    const shouldGenerate = options.generate !== false
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30_000
    const limits: Limits = {
      title: boundedLimit(options.titleLimit, defaultLimits.title, 80),
      body: boundedLimit(options.bodyLimit, defaultLimits.body, 300),
    }
    const exposeTool = options.tool !== false
    const controller = new AbortController()
    let encryptionReady = false
    const { accept, current, pair, post } = createNotificationSender({
      storage: ctx.storage,
      relayOrigins,
      allowHTTP,
      signal: controller.signal,
      encryptionEnabled: () => encryptionReady,
    })
    try {
      await ctx.rpc.register(MobileNotifications, {
        pair: async (input, context) => {
          try {
            return await pair(input)
          } catch {
            return context.error("pairing_failed", "Couldn’t pair mobile notifications", {})
          }
        },
      })
      encryptionReady = true
    } catch {
      warn("Notification enrollment unavailable; sending generic notifications only.")
    }
    /** Sessions whose agent messaged the phone during the current run. */
    const messaged = shared.messaged

    // Durable state: `pending:<session>` is the run the phone prompted, `phone:<session>` the session's latest
    // phone callback ({@link Phone}, kept 30 days), `input:<session>` that a message arrived since its last run ended. Memory backs it up where storage is unavailable.
    const memory = shared.memory
    const load = async <T>(key: string) =>
      (memory.get(key) ?? (await ctx.storage.get(key).catch(() => undefined))) as T | undefined
    const save = async (key: string, value: Pending | Phone | string) => {
      memory.set(key, value)
      await ctx.storage.set(key, value).catch(() => undefined)
    }
    const drop = async (key: string) => {
      memory.delete(key)
      await ctx.storage.remove(key).catch(() => undefined)
    }
    const getSession = (sessionID: string) =>
      ctx.session.get({ sessionID: sessionID as never }, { signal: controller.signal }).catch(() => undefined)

    const notificationOf = (metadata: Record<string, unknown> | undefined) => {
      const notification = metadata?.notification
      if (!notification || typeof notification !== "object" || Array.isArray(notification)) return undefined
      return notification as Record<string, unknown>
    }
    /** The session's own Always Notify callback, when it's on. */
    const alwaysURL = (session: SessionLike) => {
      const notification = session && !session.parentID ? notificationOf(session.metadata) : undefined
      return notification?.always === true ? callbackURL(session?.metadata) : undefined
    }
    /** Save `url` as an Always Notify session's callback when it holds another. */
    const refreshAlways = async (sessionID: string, session: SessionLike, url: string) => {
      const notification = notificationOf(session?.metadata)
      if (!session || session.parentID || notification?.always !== true || notification.callbackURL === url) return
      await ctx.session
        .update({ sessionID: sessionID as never, metadata: { ...session.metadata, notification: { ...notification, callbackURL: url } } } as never)
        .catch(() => warn("Couldn't refresh the session's callback."))
    }
    /** The Always Notify callback, following its phone to a renewed one and saving that to the session. */
    const alwaysCallback = async (sessionID: string, session: SessionLike) => {
      const url = alwaysURL(session)
      if (!url) return undefined
      const latest = await current(url)
      if (latest === url) return url
      // Re-read: a switch turned off (or handed to another phone) meanwhile is neither written back nor notified.
      const now = await getSession(sessionID)
      if (alwaysURL(now) !== url) return undefined
      await refreshAlways(sessionID, now, latest)
      return latest
    }

    const callbackURL = (metadata: Record<string, unknown> | undefined) => accept(notificationOf(metadata)?.callbackURL)

    /** The session's stored phone callback, dropping it once it's stale or no longer allowed. */
    const loadPhone = async (sessionID: string) => {
      const key = `phone:${sessionID}`
      const value = await load<Partial<Phone> | string>(key)
      if (value === undefined) return undefined
      const entry = typeof value === "string" ? { url: value } : value && typeof value === "object" ? value : {}
      const url = accept(entry.url)
      if (!url || (typeof entry.savedAt === "number" && Date.now() - entry.savedAt > PHONE_TTL_MS)) {
        await drop(key)
        return undefined
      }
      // A legacy entry has no date: start its 30 days now.
      if (typeof entry.savedAt !== "number") await save(key, { url, savedAt: Date.now() })
      return url
    }

    /** The relay answered 410 (the token is gone or the URL expired): forget the session's entries for that URL. */
    const forget = async (sessionID: string, url: string) => {
      if ((await load<Pending>(`pending:${sessionID}`))?.url === url) await drop(`pending:${sessionID}`)
      const phone = await load<Phone | string>(`phone:${sessionID}`)
      if ((typeof phone === "string" ? phone : phone?.url) === url) await drop(`phone:${sessionID}`)
    }

    // Plugin instances receive events beyond their own location; only the session's own location may notify.
    const owns = (session: { location: { directory: string } } | undefined) =>
      session !== undefined && session.location.directory === ctx.location.directory

    /** The notification to send, or undefined when `decide` and the model says the user doesn't need one. */
    const compose = async (sessionID: string, status: Status, error?: string, decide = false): Promise<Notification | undefined> => {
      const session = await ctx.session.get({ sessionID }, { signal: controller.signal }).catch(() => undefined)
      if (shouldGenerate) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
        const reply = await ctx.session
          .generate({ sessionID, prompt: prompt(status, limits, error, decide) }, { signal })
          .then((result) => result.text)
          .catch(() => {
            warn("Notification generation failed; sending the fallback.")
            return undefined
          })
        const generated = reply === undefined ? undefined : parse(reply, limits)
        if (reply !== undefined && !generated) warn("Model reply was not a valid notification; sending the fallback.")
        if (generated?.notify === false) return undefined
        if (generated) return { title: generated.title, body: generated.body }
      }
      return fallback(status, session?.title, limits)
    }

    const finish = async (eventID: string, sessionID: string, status: Status, error?: string) => {
      const session = await getSession(sessionID)
      if (!owns(session) || !claim(`finish:${eventID}`)) return
      const stored = await load<Pending>(`pending:${sessionID}`)
      if (stored) await drop(`pending:${sessionID}`)
      const entry = stored && accept(stored.url) ? stored : undefined
      const input = await load<string>(`input:${sessionID}`)
      await drop(`input:${sessionID}`)
      // Always Notify skips runs that only a background shell or subagent finishing woke.
      const url = entry?.url ?? (input ? await alwaysCallback(sessionID, session) : undefined)
      // The agent already told the phone what happened this run.
      if (messaged.delete(sessionID) || !url) return
      // A run the user didn't start notifies only when it tells them something; failures always do.
      const notification = await compose(sessionID, status, error, !entry && status === "succeeded")
      if (!notification) return
      const { status: code } = await post(url, { ...notification, sessionID, status })
      if (code === 410) await forget(sessionID, url)
    }

    /** The phone callback for a session, or the nearest ancestor's (subagents run under the phone's session). */
    const phoneFor = async (sessionID: string) => {
      let id: string | undefined = sessionID
      for (let depth = 0; id && depth < 8; depth++) {
        const session = await getSession(id)
        const stored = await loadPhone(id)
        const url = stored ? await current(stored) : await alwaysCallback(id, session)
        if (url) return { url, sessionID: id, stored }
        id = session?.parentID
      }
      return undefined
    }

    if (exposeTool) {
      void ctx.tool
        .transform((tools) => {
          tools.add({
            name: "notify_phone",
            options: { codemode: false },
            description:
              "Send a push notification to the user's iPhone (the OpenCode iOS app) with a custom title and body. " +
              "Use it when the user asked to be told about something, or for news they'd want while away. " +
              "Requires this session or a parent to have a phone callback. A successful alert replaces this run’s completion alert.",
            input: Schema.Struct({
              title: Schema.String.annotate({ description: `A few words, at most ${80} characters.` }),
              body: Schema.String.annotate({ description: `What happened or what to do next, at most ${300} characters.` }),
            }),
            execute: async ({ title, body }, context) => {
              const clean = { title: clip(title, 80), body: clip(body, 300) }
              if (!clean.title || !clean.body) return { content: "Not sent: the title and body must not be empty." }
              const phone = await phoneFor(context.sessionID)
              if (!phone)
                return {
                  content:
                    "Not sent: no phone to notify. Notifications reach the iPhone only for sessions started from the " +
                    "OpenCode iOS app with notifications on.",
                }
              const { sent, preview, status } = await post(phone.url, {
                ...clean,
                sessionID: phone.sessionID,
                status: "succeeded",
              })
              if (status === 410) {
                await forget(phone.sessionID, phone.url)
                // The stored callback it was followed from is older, so it's gone too.
                if (phone.stored && phone.stored !== phone.url) await forget(phone.sessionID, phone.stored)
              }
              if (sent) messaged.add(phone.sessionID)
              if (!sent) return { content: "Not sent: the notification relay didn't accept it." }
              return { content: preview ? "Encrypted notification sent." : "A generic alert was sent; no secure pairing was available to send the title and message." }
            },
          })
        })
        .catch(() => warn("Couldn't add the notify_phone tool."))
    }

    const run = async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        switch (event.type) {
          case "session.inbox.enqueued": {
            const { item, sessionID, inboxID } = event.data
            const source = item.type === "synthetic" ? item.payload.metadata?.source : undefined
            // A message (yours, a watcher's, another session's), not a background job's completion notice.
            if (item.type === "user" || (item.type === "synthetic" && source !== "shell" && source !== "subagent"))
              await save(`input:${sessionID}`, "1")
            if (item.type !== "user") break
            const url = callbackURL(item.payload.metadata)
            if (!url) break
            const session = await getSession(sessionID)
            if (!owns(session)) break
            await save(`pending:${sessionID}`, { url, inboxID })
            await save(`phone:${sessionID}`, { url, savedAt: Date.now() })
            // Keep an Always Notify session's callback as fresh as the phone's latest prompt.
            if (claim(`refresh:${event.id}`)) await refreshAlways(sessionID, session, url)
            break
          }
          case "session.inbox.cancelled": {
            const key = `pending:${event.data.sessionID}`
            if ((await load<Pending>(key))?.inboxID === event.data.inboxID) await drop(key)
            break
          }
          case "session.execution.succeeded":
            void finish(event.id, event.data.sessionID, "succeeded")
            break
          case "session.execution.failed":
            void finish(event.id, event.data.sessionID, "failed", event.data.error.message)
            break
          case "session.execution.interrupted":
            // Shutdown keeps the run claimed for restart; the in-memory callback cannot survive it anyway.
            if (event.data.reason !== "shutdown") void finish(event.id, event.data.sessionID, "interrupted")
            break
        }
      }
    }
    run().catch(() => {
      if (!controller.signal.aborted) warn("Event stream ended.")
    })

    return () => controller.abort()
  },
})

function boundedLimit(value: unknown, fallback: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback
}
