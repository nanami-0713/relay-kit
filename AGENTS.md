# AGENTS.md

Instructions for coding agents (Claude Code, Cursor, Codex, …) operating on
this repository. Human docs: [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md).
Protocol spec: [PROTOCOL.md](PROTOCOL.md). Security policy: [SECURITY.md](SECURITY.md).

## What this repo is

A self-hostable E2E relay server (`workers/relay`, Cloudflare Workers +
Durable Objects, deploy-to-your-own-account) plus reference implementations
of the two ends (`packages/agent` desktop, `packages/client` phone/browser)
and the protocol layer they share (`packages/core`). The relay only ever sees
ciphertext; keys never leave the two ends.

## The most common task: deploy a relay server for the user

The user wants their own relay on their own Cloudflare account.

1. `cd workers/relay`
2. `npx wrangler login` — opens the user's browser; **this step needs the
   human** (or ask them for a `CLOUDFLARE_API_TOKEN` env var for
   non-interactive setups)
3. `npx wrangler deploy` — prints the `*.workers.dev` URL when done
4. Verify: `curl <url>/` returns `404 not found` → the worker is alive
   (it only speaks `/agent` and `/c/<token>/__alma_e2e__`; a 404 on `/` is
   the health signal)
5. Optional smoke: start an agent with
   `npx -p @hsinsekai-nanami/agent relay-agent --server <url> --port <port>`
   (omit `--code` to mint a fresh pairing code — printed once, with the
   phone-side connect path)

Cost: free tier is enough — idle pairings hibernate at ≈ zero GB-s. No
database, no config to fill in.

## Before changing code

All of these must pass; CI runs the same set on Node 23 and 24:

```bash
npm run typecheck   # tsc --noEmit, source-level (no build needed)
npm run build       # compile packages/*/dist (core first — script handles order)
npm test            # fixture-based e2e
npm run test:dev    # e2e against the real Worker under wrangler dev
```

Node ≥ 23 required (tests import TypeScript sources directly). `test:dev`
needs the `workerd` install script approved (`npm install-scripts approve workerd`).

## Hard rules

- **PROTOCOL.md is the spec.** Behavior changes must update the spec and both
  server implementations (`workers/relay/src` + `test/fixtures/relay-server.mjs`)
  together. If doc and code disagree, that is a bug either way.
- `packages/core` stays zero-dependency, WebCrypto-only (Node ≥ 18, browsers,
  Capacitor WebViews must behave identically).
- Keep the Workers server free-tier compatible (WebSocket Hibernation API,
  no always-on Durable Objects, no paid bindings).
- Never commit: `wrangler.prod.toml` (the maintainer's real custom domain),
  `.npmrc` (may hold tokens), `dist/` (build output).
- npm publishing (only if the user asks): bump versions in lockstep, run
  `npm run build` first, publish in dependency order **core → agent →
   client** (tarballs ship compiled `dist/`; source-only tarballs cannot be
   imported from node_modules).

## User-facing gotchas you will be asked about

- `*.workers.dev` unreachable on their network (common in mainland China):
  agent accepts `--proxy http://…` (or `HTTPS_PROXY`); for phones, bind a
  custom domain hosted on the same CF account — commented example in
  `workers/relay/wrangler.toml`.
- Live logs: `npx wrangler tail`.
- Close codes cheat sheet: PROTOCOL.md §9 (`4404` agent offline, `1011`
  agent dropped, `4000` preempted, handshake `auth-failed` = wrong code).
- Security posture to relay honestly: pairing code = full authority; no
  built-in rate limiting — public relays should front with CF WAF rules.
