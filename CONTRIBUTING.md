# Contributing

Thanks for considering it — this is a small, deliberately boring codebase;
keep it that way.

## Setup

- Node ≥ 23 (tests import the TypeScript sources directly)
- `npm install` (approve the `workerd` install script when npm asks — it
  powers `wrangler dev`)

## Before you push

```bash
npm run typecheck   # tsc --noEmit over packages + the worker
npm test            # fixture-based e2e
npm run test:dev    # e2e against the real Worker (wrangler dev / miniflare)
```

All four green, please. CI runs the same set on Node 23 and 24.

## Rules of the road

- **Protocol changes go through `PROTOCOL.md` first.** The doc is the spec —
  server, agent and client are its implementations. If behavior and doc
  disagree, that's a bug either way; fix the pair together.
- The Workers server must keep working on the **free tier** (no always-on
  Durable Objects, no paid bindings).
- `packages/core` stays zero-dependency and WebCrypto-only (Node ≥ 18,
  browsers, Capacitor WebViews must behave identically).
- Tests are real end-to-end regressions, not mock theatre — a bug fix should
  come with the test that would have caught it.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — never a public issue.
