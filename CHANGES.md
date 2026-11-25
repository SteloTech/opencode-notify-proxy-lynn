# Changes from upstream 0.1.2

All changes are in `src/encryption.ts`. Every other file is identical to
`opencode-mobile-notifications@0.1.2`.

## Import

```diff
 import { createCipheriv, createECDH, createHash, ECDH, hkdfSync, randomBytes } from "node:crypto"
+import { request as httpRequest } from "node:http"
+import { connect as tlsConnect } from "node:tls"
 import type { Plugin } from "@opencode/plugin"
```

## `post()` sends through a proxy

Before, the request went out with a bare `fetch`:

```diff
-      const response = await fetch(url, {
-        method: "POST",
-        headers: { "content-type": "application/json" },
-        body,
-        redirect: "error",
-        signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10_000)]),
-      })
+      const response = await postViaProxy(url, body, options.signal)
```

## New helpers

Added after `createNotificationSender`:

- `proxyURL()` — reads `OPENCODE_NOTIFY_PROXY`, defaulting to `http://127.0.0.1:7890`.
  An empty value, `direct`, or `none` returns `undefined` and bypasses the proxy.
- `proxyEndpoint()` — splits the proxy URL into host and port.
- `postViaProxy()` — opens an HTTP `CONNECT` tunnel to the relay, wraps the socket in TLS
  with the correct SNI, writes a minimal HTTP/1.1 POST, and resolves with the status code.
  Sends `Proxy-Authorization` when the proxy URL carries credentials.
- `directPost()` — the original `fetch` behaviour, used when the proxy is bypassed.

The 10-second timeout and the `AbortSignal` from the plugin are both still honoured.

## Why not an HTTP agent on `fetch`

Bun's `fetch` does not consistently honour `HTTPS_PROXY`, and it does not accept a Node
`Agent`-based proxy configuration. Opening the tunnel with `node:http` and `node:tls` is
deterministic under Bun.

## Encryption is untouched

The `pair()` method, key derivation, AES-GCM sealing, payload limits, storage keys, and
30-day expiry are exactly as upstream. Only the transport of the finished sealed box changed.
