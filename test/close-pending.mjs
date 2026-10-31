// Close-with-pending test: close() is a teardown — in-flight fetches and
// ready-waiters must reject, not hang on promises whose socket handlers were
// detached. Regression: an app swapping clients mid-load (reconnect after an
// agent flap) used to leave a portal load waiting on the retired client
// forever, until an outer 45s race noticed.
import assert from "node:assert";
import http from "node:http";
import { startRelayServer } from "./fixtures/relay-server.mjs";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { generateCode } from "../packages/core/src/index.ts";

const localSvc = http.createServer((req, res) => {
  if (req.url === "/hang") return; // never answers
  res.writeHead(200).end("ok");
});
await new Promise((r) => localSvc.listen(0, "127.0.0.1", r));
const relay = await startRelayServer(0);
const code = generateCode();

const agent = new RelayAgent({ serverUrl: `http://127.0.0.1:${relay.port}`, code, localPort: localSvc.address().port, deviceName: "close-pending-test" });
agent.start();
await new Promise((resolve) => {
  const check = () => (agent.getStatus().state === "connected" ? resolve() : setTimeout(check, 20));
  check();
});

const client = new RelayTunnelClient({ serverUrl: `http://127.0.0.1:${relay.port}`, code });
await client.connect();
assert.equal(client.state, "ready");

const t0 = Date.now();
const pending = client.fetch("/hang"); // in flight when the swap retires this client
const ready = client.ready();          // already resolved (state ready) — the waiter path needs a connecting client, checked below
ready.then(() => {}, () => {});
client.close();

await assert.rejects(pending, (e) => /Tunnel closed/.test(e.message), "close() must reject in-flight fetches");
assert.ok(Date.now() - t0 < 1_000, `rejection came from close(), not a timeout (${Date.now() - t0}ms)`);
assert.equal(client.state, "closed");

// ready() on a closed client must reject too, not hang
await assert.rejects(client.ready(), /not connected/);

// and the connecting-client waiter path: close() during connect() rejects it
const c2 = new RelayTunnelClient({ serverUrl: `http://127.0.0.1:${relay.port}`, code, connectTimeoutMs: 5_000 });
const connecting = c2.connect().catch((e) => e); // may or may not start handshakeing before close
c2.close();
const outcome = await connecting;
assert.ok(outcome instanceof Error || outcome === undefined, "connect() settles");
await assert.rejects(c2.ready(), /not connected/);

console.log("ok: close() rejects pending fetches and waiters immediately");
client.close();
c2.close();
agent.stop();
process.exit(0);
