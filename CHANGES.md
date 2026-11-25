# Changes

This repository is maintained independently. Unlike a patch, it is a complete, installable
plugin: the files here run as they are.

## 0.1.2 — relaying through a proxy

All changes are in `src/encryption.ts`. Everything else matches the origin code.

### Import

```diff
 import { createCipheriv, createECDH, createHash, ECDH, hkdfSync, randomBytes } from "node:crypto"
+import { request as httpRequest } from "node:http"
+import { connect as tlsConnect } from "node:tls"
 import type { Plugin } from "@opencode/plugin"
```

### `post()` sends through a proxy

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

### New helpers

- `proxyURL()` — reads `OPENCODE_NOTIFY_PROXY`, defaulting to `http://127.0.0.1:7890`.
  An empty value, `direct`, or `none` returns `undefined` and bypasses the proxy.
- `proxyEndpoint()` — splits the proxy URL into host and port.
- `postViaProxy()` — opens an HTTP `CONNECT` tunnel to the relay, wraps the socket in TLS with
  the correct SNI, writes a minimal HTTP/1.1 POST, and resolves with the status code. Sends
  `Proxy-Authorization` when the proxy URL carries credentials.
- `directPost()` — the original `fetch` behaviour, used when the proxy is bypassed.

The 10-second timeout and the plugin's `AbortSignal` are both still honoured.

### Why not an HTTP agent on `fetch`

Bun's `fetch` does not consistently honour `HTTPS_PROXY`, and it does not accept a Node
`Agent`-based proxy configuration. Opening the tunnel with `node:http` and `node:tls` is
deterministic under Bun.

### Package metadata

Renamed to `opencode-notify-proxy-lynn` and dependency ranges relaxed so it installs against
current OpenCode releases (`@opencode/plugin: latest`, `effect: ^4.0.0-rc.112`).

### Encryption is untouched

Pairing, key derivation, AES-GCM sealing, payload limits, storage keys, and 30-day expiry are
exactly as the origin code. Only the transport of the finished sealed box changed.
