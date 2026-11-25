# opencode-notify-proxy-lynn

Encrypted [OpenCode](https://opencode.ai) iOS push notifications, sent through a local HTTP proxy.

Independently maintained by SteloTech. Install it from this repository and you are done — no
second package, no patch to apply.

## Why this exists

The upstream relay (`opencode-notify-relay.anomalyco.workers.dev`) is unreachable from some
networks: on a filtered connection its DNS answers are poisoned and its Cloudflare IPs are reset
at the TLS handshake, so a direct `fetch` never completes. OpenCode's server process does not
use the system proxy, and Bun's global `fetch` does not reliably honour `HTTPS_PROXY`.

This plugin sends the relay request through a local proxy instead, which fixes delivery without
changing how the server is launched.

## Install

Add this repository to your `plugins` list:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["github:SteloTech/opencode-notify-proxy-lynn"]
}
```

Or from a local checkout:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-notify-proxy-lynn"]
}
```

No build step: OpenCode reads `index.ts` and `src/` as TypeScript. Restart only if your OpenCode
version does not reload plugins on config change.

## Proxy configuration

The proxy defaults to `http://127.0.0.1:7890`. Override it on the server process:

```sh
OPENCODE_NOTIFY_PROXY=http://127.0.0.1:1080    # another proxy
OPENCODE_NOTIFY_PROXY=direct                   # bypass the proxy
OPENCODE_NOTIFY_PROXY=                         # also bypass
```

The proxy must support `CONNECT` for HTTPS. Credentials in the URL
(`http://user:pass@host:port`) are forwarded as `Proxy-Authorization`.

## Behaviour

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

## Maintenance

This repository is maintained independently of upstream and may diverge. Changes are recorded
in [`CHANGES.md`](CHANGES.md).

## Origin

The initial code came from the npm package
[`opencode-mobile-notifications`](https://www.npmjs.com/package/opencode-mobile-notifications)
version 0.1.2, published by `mandarin3d <ryan@mandarin3d.com>`.

That package declares no license, and its `repository`, `homepage`, and `bugs` fields all point
at `https://github.com/anomalyco/opencode-ios`, which returns 404. See [`NOTICE`](NOTICE) before
redistributing this code. Nothing in this repository grants a license that upstream did not
grant.
