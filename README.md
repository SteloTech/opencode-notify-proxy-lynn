# opencode-notify-proxy

Encrypted [OpenCode](https://opencode.ai) iOS push notifications, sent through a local HTTP proxy.

This is a drop-in replacement for `opencode-mobile-notifications`. It does everything the
original does, with one change: the request to the notification relay goes through a local
proxy instead of connecting directly.

## Why

The notification relay (`opencode-notify-relay.anomalyco.workers.dev`) is unreachable from
some networks — on a filtered connection its DNS answers are poisoned and its Cloudflare IPs
are reset at the TLS handshake, so a direct `fetch` never completes. OpenCode's server process
does not use the system proxy, and Bun's global `fetch` does not reliably honour `HTTPS_PROXY`.
Routing the relay request explicitly through the proxy fixes delivery without changing how the
server is launched.

## Install

Add a local checkout to your `plugins` list:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["/absolute/path/to/opencode-notify-proxy"]
}
```

Or point at the repository directly:

```jsonc
{
  "plugins": ["github:YOUR_ORG/opencode-notify-proxy"]
}
```

A plugin directory needs no build step: OpenCode reads `index.ts` and `src/` as TypeScript.

## Proxy configuration

The proxy defaults to `http://127.0.0.1:7890`. Override it with an environment variable on the
server process:

```sh
OPENCODE_NOTIFY_PROXY=http://127.0.0.1:1080    # another proxy
OPENCODE_NOTIFY_PROXY=direct                   # bypass the proxy (old behaviour)
OPENCODE_NOTIFY_PROXY=                         # also bypass
```

The proxy must support `CONNECT` for HTTPS. Credentials in the URL
(`http://user:pass@host:port`) are forwarded as `Proxy-Authorization`.

## Behaviour

Unchanged from the original package:

- **Completion notifications.** When a run ends in a session that has a phone callback, the
  session's own model writes a short lock-screen notification. Sent on success, failure, or
  interruption — but not when the run was ended by server shutdown.
- **Always Notify.** If the session's metadata sets `notification.always = true`, every run in
  that session notifies, not only runs prompted from the phone. Routine housekeeping stays quiet.
- **`notify_phone` tool.** Lets an agent send a custom title and body to the same phone. A run
  that sends one skips its own completion notification.
- **Subagents never notify.**

Payloads are encrypted for the paired phone: ECDH P-256 to derive a shared secret, HKDF-SHA256,
then AES-256-GCM. The relay receives only a sealed box and cannot read the content. Unpaired or
legacy callbacks receive `{}`.

Callbacks and pairings live in plugin storage and expire after 30 days. Pairing again from the
iOS app renews them.

## Requirements

- The OpenCode iOS app, paired with notifications enabled.
- A local proxy that can reach `*.workers.dev`.

## Credit and licensing

The code in this repository originates from the npm package
[`opencode-mobile-notifications`](https://www.npmjs.com/package/opencode-mobile-notifications)
version 0.1.2, published by `mandarin3d <ryan@mandarin3d.com>`.

That package declares no license. Its `repository`, `homepage`, and `bugs` fields all point at
`https://github.com/anomalyco/opencode-ios`, which returns 404. The upstream source is therefore
not available, and no permission to redistribute has been published.

**Read this before using or redistributing this repository.** Nothing here grants you a license
that upstream did not grant. If you need clear rights, ask the original publisher, or use the
npm package directly and apply the proxy change yourself.

The only change made here is in `src/encryption.ts`: `post()` now calls `postViaProxy()` instead
of `fetch()` directly, and supporting functions were added below the factory. See
[`CHANGES.md`](CHANGES.md).
