# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately — do **not** open a public issue:

1. **Preferred:** use this repo's GitHub *Security Advisories* page
   ("Report a vulnerability" under Security → Advisories).
2. Alternatively, open a private security advisory draft or contact the
   maintainer through the repo's listed channels.

Include reproduction steps and, where relevant, which component is affected
(`workers/relay` server, `packages/core` crypto, agent, client, or the
protocol design in `PROTOCOL.md`). We aim to respond within 72 hours.

## Scope

- The Cloudflare Workers relay server (`workers/relay`)
- The protocol implementation and crypto in `packages/core`
- The reference agent (`packages/agent`) and client (`packages/client`)

Out of scope: denial of service against a relay you don't operate (see the
threat model in the README — availability is explicitly not guaranteed), and
compromise of the pairing code itself (it is the credential).

## Known limitations (by design, documented, not bugs)

- The relay sees traffic metadata (sizes, timing); there is no padding or
  traffic shaping.
- A leaked **routing token** (the phone-side connect URL) enables
  agent-slot preemption / room DoS, but never decryption.
- No built-in rate limiting or abuse controls — front public deployments
  with Cloudflare WAF rules.
- The PAKE-style handshake is a homegrown scheme distilled from Alma's
  client. It binds the transcript into every key and compares confirms in
  constant time, but it is **not formally verified and has not been audited**.

## Supported versions

Only the latest commit on `main` is supported.
