// Watchdog test: a fetch whose endpoint never answers must be failed by the
// client's idle watchdog (a tunnel gone silent with a request pending), not
// hang forever. Reuses the smoke-test fixture relay.
import assert from "node:assert";
import http from "node:http";
import { startRelayServer } from "./fixtures/relay-server.mjs";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { generateCode } from "../packages/core/src/index.ts";

const localSvc = http.createServer((req, res) => {
  if (req.url === "/hang") return; // never answers — the wedged-endpoint stand-in
  res.writeHead(200).end("ok");
});
await new Promise((r) => localSvc.listen(0, "127.0.0.1", r));
const relay = await startRelayServer(0);
const code = generateCode();

const agent = new RelayAgent({ serverUrl: `http://127.0.0.1:${relay.port}`, code, localPort: localSvc.address().port, deviceName: "watchdog-test" });
agent.start();
await new Promise((resolve) => {
  const check = () => (agent.getStatus().state === "connected" ? resolve() : setTimeout(check, 20));
  check();
});

const states = [];
const client = new RelayTunnelClient({
  serverUrl: `http://127.0.0.1:${relay.port}`,
  code,
  idleTimeoutMs: 1500,
  onStateChange: (s) => states.push(s),
});
await client.connect();
assert.equal(client.state, "ready");

const t0 = Date.now();
await assert.rejects(
  client.fetch("/hang"),
  (e) => /went silent/.test(e.message),
  "the wedged fetch must be rejected by the watchdog",
);
const waited = Date.now() - t0;
assert.ok(waited < 10_000, `watchdog fired late: ${waited}ms`);
assert.equal(client.state, "error");
console.log(`ok: fetch rejected after ${waited}ms, client state = error, states = ${states.join(">")}`);

// a fetch after reconnect works again
await new Promise((r) => setTimeout(r, 200));
await client.connect();
const r2 = await client.fetch("/");
assert.equal(r2.status, 200);
console.log("ok: reconnect after watchdog, fetch / ->", r2.text());

client.close();
agent.stop();
process.exit(0);
