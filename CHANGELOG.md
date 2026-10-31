# Changelog

## 0.2.3 — 2026-10-31

Server hardening ahead of going public:

- **Early-frame buffer byte cap (64 KiB) on both servers** (Worker + Node
  fixture, parity). The frame-count cap alone allowed 256 × 1 MiB ≈ 256 MB of
  DO storage abuse per room from an unauthenticated client on a public relay;
  a legit handshake totals <1 KB, so the cap is invisible to honest clients.
  PROTOCOL.md §5 now documents the limit.

## 0.2.2 — 2026-10-31

Published to npm as `@hsinsekai-nanami/{core,agent,client}` (the bare name
`relay-kit` on npm belongs to an unrelated project).

- **Tarballs now ship compiled ESM (`dist/` + `.d.ts`) alongside the TS
  source.** 0.2.1 shipped source-only, which cannot be imported directly from
  `node_modules` — Node refuses to type-strip inside `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so only bundler users could
  consume it. With `dist/`, plain `node` (≥18) works; `relay-agent` CLI bin
  now points at `dist/cli.js`. 0.2.1 on npm is deprecated in favor of 0.2.2.
- Engine floors relaxed to Node ≥ 18 now that published artifacts are plain
  ESM (the repo itself still needs Node ≥ 23 to run tests directly on TS
  sources).

## 0.2.1 — 2026-10-31

Open-source readiness pass (full review → fixes):

- **Replay protection (behavior fix):** `GcmStream.open` now rejects any frame
  whose counter is ≤ the highest seen; a duplicated frame kills the session
  with a clear error instead of silently corrupting streams. Both ends check.
  PROTOCOL.md §2.3 updated to match (the old "monotonic counter ⇒ replay-proof"
  claim was about the sender only).
- **`hcancel`/`herr` semantics aligned:** agents now answer a cancelled
  request with best-effort `herr("cancelled")` (PROTOCOL.md §4), and the
  reference client's `fetch()` accepts an `AbortSignal` — aborting settles
  locally, sends `hcancel`, and leaves the tunnel healthy. New smoke test T6.
- **The real Worker is now tested in CI:** `test/workers.mjs` boots
  `wrangler dev` (miniflare) and runs the live e2e pair against the actual
  Durable Object code, closing the "fixture-only coverage" gap.
- **Type checking:** `tsc --noEmit` (`npm run typecheck`) over packages and
  the worker; two latent annotation bugs fixed (`hkdfWithLabel` param type,
  worker `#openTunnel` agent type).
- **Docs:** PROTOCOL.md gains a close-code quick reference (§9), size limits
  incl. the Cloudflare 1 MiB message cap (§6), and register-field semantics
  (§3). READMEs reposition the repo (relay server first, agent/client as
  reference implementations) and add a security & threat-model section.
- **Hygiene:** neutral test fixture names, `engines` field on
  `@relay-kit/agent` (Node ≥ 23), SECURITY.md / CONTRIBUTING.md added.

## 0.2.0 — 2026-10-30

Initial release: `relay-e2e/v1` protocol (distilled from Alma v0.4.213 with
permission) — hibernating Cloudflare Workers relay, Node agent,
browser/Capacitor client, Node fixture relay, local e2e suite, live tests.
