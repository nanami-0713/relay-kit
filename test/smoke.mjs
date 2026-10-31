// End-to-end smoke test: fake local service (local HTTP+WS) + relay + agent + phone.
// Everything runs in-process against the Node fixture relay.
//
//   node test/smoke.mjs

import assert from "node:assert";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startRelayServer } from "./fixtures/relay-server.mjs";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { E2ESession, deriveRoutingToken, generateCode } from "../packages/core/src/index.ts";

const log = (...a) => console.log("   ", ...a);

// ---- 1. Fake local service: HTTP + WS echo on a local port -------------------------
const localSvcServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "localSvc", version: "1.0.0" }));
    } else if (req.url === "/hang") {
      return; // never answers — the wedged-endpoint stand-in for the cancel test
    } else if (req.url === "/echo" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ echoed: JSON.parse(Buffer.concat(chunks).toString()).msg }));
    } else {
      res.writeHead(404).end();
    }
  });
});
const localSvcWss = new WebSocketServer({ noServer: true });
localSvcServer.on("upgrade", (req, socket, head) => {
  localSvcWss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) ws.send(data);
      else ws.send(`echo:${data.toString()}`);
    });
  });
});
await new Promise((r) => localSvcServer.listen(0, "127.0.0.1", r));
const localSvcPort = localSvcServer.address().port;
log(`fake localSvc on :${localSvcPort}`);

// ---- 2. Relay + agent -------------------------------------------------------
const relay = await startRelayServer(0);
const relayPort = relay.port;
log(`relay on :${relayPort}`);

const code = generateCode();
const routingToken = await deriveRoutingToken(code);

const agentStates = [];
const agent = new RelayAgent({
  serverUrl: `http://127.0.0.1:${relayPort}`,
  code,
  localPort: localSvcPort,
  deviceName: "test-desktop",
  onStateChange: (s) => agentStates.push(s.state),
});
agent.start();
await new Promise((resolve) => {
  const check = () => (agent.getStatus().state === "connected" ? resolve() : setTimeout(check, 20));
  check();
});
log("agent connected");

// ---- 3. Phone: @relay-kit/client over the relay -------------------------------
function makePhone() {
  return new RelayTunnelClient({
    serverUrl: `http://127.0.0.1:${relayPort}`,
    code,
    onStateChange: (s, d) => log(`phone: ${s}${d ? ` (${d})` : ""}`),
  });
}

// ---- Tests -------------------------------------------------------------------
{
  // T1: GET over the tunnel hits the fake local service.
  const phone = makePhone();
  await phone.connect();
  const res = await phone.fetch("/hello", { headers: { accept: "application/json" } });
  assert.equal(res.status, 200);
  assert.equal(res.json().app, "localSvc");
  log("T1 GET /hello via tunnel ✓");
  phone.close();
}

{
  // T2: POST with body round-trips.
  const phone = makePhone();
  await phone.connect();
  const res = await phone.fetch("/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg: " vibe coding from the phone " }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json().echoed, " vibe coding from the phone ");
  log("T2 POST /echo via tunnel ✓");
  phone.close();
}

{
  // T3: WebSocket tunnel echo.
  const phone = makePhone();
  await phone.connect();
  const sock = await phone.openSocket("/");
  const got = await new Promise((resolve, reject) => {
    sock.onmessage = (data) => {
      if (typeof data === "string") resolve(data);
    };
    sock.onerror = (e) => reject(new Error(String(e)));
    sock.send("ping");
    setTimeout(() => reject(new Error("ws tunnel timeout")), 10_000);
  });
  assert.equal(got, "echo:ping");
  log("T3 WebSocket tunnel ✓");
  sock.close();
  phone.close();
}

{
  // T4: wrong code fails the handshake (MITM / typo safety).
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/c/${routingToken}/__alma_e2e__`);
  const err = await new Promise((resolve) => {
    const session = new E2ESession({
      role: "initiator",
      code: generateCode(), // wrong pairing code
      send: (d) => ws.send(d),
      onReady: () => resolve(null),
      onFrame: () => {},
      onError: (m) => resolve(m),
    });
    ws.on("open", () => void session.start());
    ws.on("message", (d, isBinary) => void session.onMessage(isBinary ? new Uint8Array(d) : d.toString()));
    ws.on("close", () => resolve("closed before ready"));
    setTimeout(() => resolve("timeout"), 10_000);
  });
  assert.ok(err && /authentication failed/i.test(err), `expected auth failure, got: ${err}`);
  log("T4 wrong-code handshake rejected ✓");
  try {
    ws.close();
  } catch {}
}

{
  // T5: preemption — a second agent with the same pairing takes over (4000).
  const states2 = [];
  const agent2 = new RelayAgent({
    serverUrl: `http://127.0.0.1:${relayPort}`,
    code,
    localPort: localSvcPort,
    deviceName: "second-desktop",
    onStateChange: (s) => states2.push(s.state),
  });
  agent2.start();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(agent2.getStatus().state, "connected");
  assert.equal(agent.getStatus().state, "replaced");
  log("T5 preemption (second agent wins, first is replaced) ✓");
  agent2.stop();
  // bring the first agent back — a replaced agent stays parked until an
  // explicit reconnect(), and T6 needs a registered agent again
  agent.reconnect();
  await new Promise((resolve) => {
    const check = () => (agent.getStatus().state === "connected" ? resolve() : setTimeout(check, 20));
    check();
  });
}

{
  // T6: AbortSignal cancels a wedged fetch — rejects locally with "aborted",
  // sends hcancel to the agent, and leaves the tunnel healthy for the next
  // request (the agent's herr("cancelled") arrives after the pending was
  // already settled and must be ignored without error).
  const phone = makePhone();
  await phone.connect();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(phone.fetch("/hang", { signal: ac.signal }), (e) => /aborted/.test(e.message));
  assert.ok(Date.now() - t0 < 2_000, "abort rejected locally, not by a watchdog");
  const res = await phone.fetch("/hello"); // tunnel must still work afterwards
  assert.equal(res.status, 200);
  log("T6 fetch abort → hcancel, tunnel stays healthy ✓");
  phone.close();
}

// ---- Teardown ----------------------------------------------------------------
agent.stop();
await new Promise((r) => setTimeout(r, 200));
relay.close();
localSvcWss.close();
localSvcServer.close();

console.log("\nAll smoke tests passed ✓");
process.exit(0);
