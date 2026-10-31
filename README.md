# relay-kit

English | [中文](README.zh-CN.md)

[![npm core](https://img.shields.io/npm/v/@hsinsekai-nanami/core?label=%40hsinsekai-nanami%2Fcore)](https://www.npmjs.com/package/@hsinsekai-nanami/core)
[![npm agent](https://img.shields.io/npm/v/@hsinsekai-nanami/agent?label=%40hsinsekai-nanami%2Fagent)](https://www.npmjs.com/package/@hsinsekai-nanami/agent)
[![npm client](https://img.shields.io/npm/v/@hsinsekai-nanami/client?label=%40hsinsekai-nanami%2Fclient)](https://www.npmjs.com/package/@hsinsekai-nanami/client)

**A self-hostable, end-to-end encrypted relay server — deploy it to your own
Cloudflare account in one command.** The relay is deliberately *boring*: it
sits between a phone (anywhere on the internet) and a service on your desktop
and only ever sees ciphertext bytes and a routing token; decryption happens
exclusively at the two ends.

```
phone (remote) ──ciphertext──▶ relay (CF Workers, blind) ◀──ciphertext── agent (desktop) ──plaintext──▶ 127.0.0.1:<port>
```

**What this repo ships** — the relay server is the product; everything else
exists so the server is testable and immediately usable:

- `workers/relay` — the **relay server** (Cloudflare Workers + Durable Objects). Deploy and go.
- `packages/agent` + `packages/client` — **reference implementations** of the
  two ends. You can use them as-is (the agent already proxies any local
  HTTP/WS port) or write your own against [`PROTOCOL.md`](PROTOCOL.md).
- `test/fixtures/relay-server.mjs` — a protocol-identical Node relay, as a
  test fixture and a single-process self-hosting alternative.

The `relay-e2e/v1` protocol implemented here was distilled by reverse-engineering
the relay server of **Alma** (v0.4.213 — an AI assistant app by yetone), with
its author's permission. The project itself is service-agnostic: attach it to
any local HTTP/WS port. Note that the protocol string differs from Alma's
official `alma-relay-e2e/v1`, so this is **not wire-compatible with official
Alma clients out of the box** — see PROTOCOL.md §7 for what interop would take.

The pairing credential is a single 256-bit code that doubles as both the
routing-derivation salt and the PAKE salt — without the code, nobody can
complete the handshake, **including the relay itself**.

## Highlights

- **Blind relay.** The server routes by token and shuffles bytes. No plaintext, ever.
- **One code is everything.** Routing token and PAKE salt are derived from the
  same 256-bit code; a man in the middle without it learns nothing and cannot
  interpose.
- **Free-tier friendly.** Each pairing lives in one Durable Object built on the
  WebSocket **Hibernation API**: idle rooms evict their isolate, so a pairing
  that is connected but quiet costs ≈ zero GB-s. A 24/7 agent plus occasional
  phone use fits comfortably inside the Cloudflare Workers free tier.
- **Zero-dependency core.** `packages/core` is WebCrypto only — runs
  identically on Node ≥ 18, browsers, and Capacitor WebViews.
- **Hardened by real-device use.** Phone radio drops, mainland-China networks,
  proxies, half-dead tunnels — the client ships an idle watchdog and teardown
  semantics that settle in-flight requests instead of hanging them.

## Layout

| Path | What it is |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | Protocol spec — frames, handshake, error codes, size limits, server behavior (中文) |
| `workers/relay` | **The relay server** — Cloudflare Workers (one hibernating Durable Object per pairing) |
| `packages/core` | Shared by both ends: E2E handshake + AES-GCM framing, zero dependencies |
| `packages/agent` | Reference desktop end: outbound WS to the relay, proxies HTTP/WS frames to a local port |
| `packages/client` | Reference phone/browser end: E2E client + `fetch()` / `WebSocket()` over the tunnel |
| `test/fixtures/relay-server.mjs` | Protocol-identical Node reference server — test fixture and self-hostable relay in one |
| `test/` | Local e2e suite + live tests against a deployed relay + e2e against the real Worker |

Other project docs: [SECURITY.md](SECURITY.md) (reporting & threat model), [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md).

## Quick start

```bash
npm install
npm test        # full local e2e: fixture relay + agent + client — no deploy needed
```

Node ≥ 23 (the tests import the TypeScript sources directly). To also run the
e2e against the *real* Worker locally (miniflare: DO + hibernation + storage):
`npm run test:dev`. `npm run typecheck` runs `tsc --noEmit` over everything.

### Deploy the relay (the whole point — ~2 minutes)

```bash
npx wrangler login     # once; you provide the Cloudflare account
cd workers/relay
npx wrangler deploy    # defaults to a workers.dev subdomain
```

No build step, no config to fill in, no database to create — the Worker is the
entire server, and a 24/7 agent plus occasional phone use fits in the free
tier. `wrangler.toml` carries a commented example for binding a custom domain.

**Even lazier path:** open this repo in your coding agent (Claude Code,
Cursor, …) and say "deploy my relay" — [`AGENTS.md`](AGENTS.md) teaches it
the whole path, including verification. You bring the Cloudflare account and
one browser click.

### Attach a local service

```bash
node packages/agent/src/cli.ts \
  --server https://<your-relay>.workers.dev \
  --port 3425            # omit --code to generate a fresh pairing code
```

The CLI prints the pairing code and the phone-side URL. On the other end,
`packages/client` connects to `wss://<relay>/c/<routingToken>/__alma_e2e__`,
completes the E2E handshake with the same code, and from then on every request
through its `fetch()` / `WebSocket()` lands on `127.0.0.1:<port>` — the
gateway API behind a local dashboard, a dev server, anything.

## Tests

| File | Covers |
|---|---|
| `test/smoke.mjs` | Full e2e against the local fixture: HTTP GET/POST, WS tunnel, wrong-code rejection, dual-agent preemption, fetch abort (hcancel) |
| `test/phone-before-agent.mjs` | Client arrives before the agent — early frames buffer and replay |
| `test/close-pending.mjs` | Teardown of a pending (not-yet-paired) client |
| `test/watchdog.mjs` | Idle watchdog reaps half-dead tunnels instead of hanging requests |
| `test/workers.mjs` | **The real Worker** under `wrangler dev` (miniflare): runs the two live tests below against the actual Durable Object code — in CI |
| `test/live.mjs` | The same e2e against a deployed relay (`--server`, optional `--proxy`) |
| `test/live-pending.mjs` | Phone-before-agent against a deployed relay — early-frame buffering across isolate eviction |

## Network reality (mainland China)

`*.workers.dev` is SNI-blocked on many mainland networks. The agent accepts
`--proxy` (or the `HTTPS_PROXY` env var). For long-term phone use, bind a
**custom domain** hosted on the same Cloudflare account to the Worker: a plain
custom domain on the CF edge is usually directly reachable, so the phone needs
no proxy at all. See the commented example in `workers/relay/wrangler.toml`.

## Security & threat model

**What the relay can never do:** read or forge tunnel traffic. Content keys
never leave the two ends; the relay's view is ciphertext + routing token +
timing/size metadata. Replay attempts are rejected by the receiver-side
counter check (PROTOCOL.md §2.3).

**What the relay (or whoever runs it) can still do — accepted by design:**

- **Deny service** — drop, delay or close connections at will. Availability is
  never guaranteed by a relay you don't control.
- **Traffic analysis** — message sizes and timing are visible; there is no
  padding or traffic shaping.
- **Room enumeration is hard, but not the point** — rooms are keyed by
  `sha256(routingToken)`; without the code you can't find a room, and even a
  leaked routing token only enables DoS (e.g. registering a rogue agent to
  occupy the pairing slot — preemption means newest wins), never decryption.
  Treat the phone-side connect URL as semi-secret anyway.
- **No rate limiting or abuse controls ship in the box** — a public relay is
  open to room-creation spam; front it with Cloudflare WAF rules if you run it
  for others.

**Pairing code properties:** the 256-bit code is the full authority (routing +
PAKE). Compromise of the code enables future MITM — rotate the pairing (new
code) if in doubt. Sessions use fresh ephemeral ECDH keys, so past sessions
stay sealed even after a code leak.

**Honesty notes:** the handshake is a homegrown PAKE-style scheme distilled
from Alma's client — sensible, transcript-bound, and constant-time where it
matters, but **not formally verified and not audited**. If you need certified
crypto, use something that has been.

Report vulnerabilities via [SECURITY.md](SECURITY.md).

## Gotchas found while porting

1. **`ws.binaryType = "arraybuffer"`** — undici/browser WebSocket hands binary
   frames as Blobs by default; ciphertext then matches no type branch and is
   silently dropped. The original client sets this; miss it and everything hangs.
2. **Tunnel-WS open semantics** — `readyState === 1` does not mean the tunnel is
   usable: wait for the `wopened` frame, or the app's first frame races the
   local connect and is dropped by the agent.
3. Node ≥ 23 runs TypeScript natively but not parameter properties
   (`constructor(private x)`) — write them out longhand.
4. **Forwarding an upgrading request into a Durable Object must pass the
   original request object** — `stub.fetch(new Request(...))` loses the
   `Upgrade` header, the DO sees plain HTTP, and the upgrade dies (close 1006).
   Use `stub.fetch(request)` so the runtime preserves upgrade semantics.

## Status

- [x] Protocol distilled (`PROTOCOL.md`, checked line-by-line against the original)
- [x] core / agent / client / Workers server / Node fixture
- [x] Local e2e suite green (HTTP GET/POST, WS tunnel, wrong-code rejection, dual-agent preemption, fetch abort)
- [x] Replay protection: receiver-side frame counter check on both ends
- [x] The real Worker is exercised in CI (`test/workers.mjs` via `wrangler dev`) — not just the Node fixture
- [x] Deployed on Cloudflare Workers; verified end-to-end from a real phone (tunnel → local gateway API → full web dashboard over the tunnel)
- [x] WebSocket Hibernation API migration — idle pairings cost ≈ zero DO duration, verified in production
- [x] MIT licensed
- [x] Published to npm as `@hsinsekai-nanami/{core,agent,client}` — compiled ESM + types, Node ≥ 18
- [ ] Request-body chunking (uploads are single-frame today; see PROTOCOL.md §6 limits)
- [ ] A companion mobile app (Capacitor shell + portal UI over the tunnel) exercises this stack daily and will be open-sourced separately

### Consuming the packages

Published to npm as [`@hsinsekai-nanami/core`](https://www.npmjs.com/package/@hsinsekai-nanami/core),
[`@hsinsekai-nanami/agent`](https://www.npmjs.com/package/@hsinsekai-nanami/agent)
and [`@hsinsekai-nanami/client`](https://www.npmjs.com/package/@hsinsekai-nanami/client).
Tarballs ship compiled ESM (`dist/`, Node ≥ 18) with types and the original
TS source. In this repo the packages are consumed as TypeScript source
(bundler, or Node ≥ 23 for the test suite).

```bash
npm install @hsinsekai-nanami/client            # phone/browser side
npx -p @hsinsekai-nanami/agent relay-agent --server https://<relay> --port 3425
```

## License

[MIT](LICENSE)
