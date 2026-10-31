// Phone-before-agent regression: a phone that connects while no agent is up
// starts its E2E hello immediately. The relay used to DROP those early frames
// (no forwarding while pending), so when an agent finally registered, both
// sides waited for the other's hello — a deadlock until the client's 20s
// connect timeout. The relay must buffer and replay. Deterministic: the
// client here connects BEFORE any agent exists.
import assert from "node:assert";
import http from "node:http";
import { startRelayServer } from "./fixtures/relay-server.mjs";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { generateCode } from "../packages/core/src/index.ts";

const localSvc = http.createServer((req, res) => res.writeHead(200).end("ok"));
await new Promise((r) => localSvc.listen(0, "127.0.0.1", r));
const relay = await startRelayServer(0);
const code = generateCode();

// client FIRST — its hello lands while the relay has no agent
const client = new RelayTunnelClient({
  serverUrl: `http://127.0.0.1:${relay.port}`,
  code,
  connectTimeoutMs: 8_000,
  onStateChange: (s) => console.log("client:", s),
});
const connecting = client.connect();

// agent joins after the phone is already waiting
await new Promise((r) => setTimeout(r, 300));
const agent = new RelayAgent({ serverUrl: `http://127.0.0.1:${relay.port}`, code, localPort: localSvc.address().port, deviceName: "late-agent" });
agent.start();

await connecting; // must resolve via buffered-hello replay, not time out
assert.equal(client.state, "ready");
const r = await client.fetch("/");
assert.equal(r.status, 200);
console.log("ok: phone-before-agent handshake completes, fetch works");

client.close();
agent.stop();
process.exit(0);
