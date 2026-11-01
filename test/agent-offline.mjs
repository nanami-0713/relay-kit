// Agent-offline + auto-reclaim regressions.
//
// Case 1: with NO agent registered, the phone's failure must carry the
// server's 4404 close (the actionable "desktop side is offline" signal),
// not a local generic timeout. This used to be unreachable in practice:
// the client's single 20s connect timer fired long before the relay's 60s
// no-agent window, so "relay unreachable" and "agent offline" looked
// identical on the phone. The handshake budget (default 70s) now outlives
// the window; here the fixture closes at 5s with the client's socket-phase
// budget set to 3s — pre-fix the 3s generic timeout won, post-fix 4404 does.
//
// Case 2: a replaced agent with reclaimMs > 0 takes the pairing back once
// the preemptor goes away (spec default — park until reconnect() — is
// covered by smoke T5).
import assert from "node:assert";
import http from "node:http";
import { startRelayServer } from "./fixtures/relay-server.mjs";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { generateCode } from "../packages/core/src/index.ts";

const localSvc = http.createServer((req, res) => res.writeHead(200).end("ok"));
await new Promise((r) => localSvc.listen(0, "127.0.0.1", r));

// ---- Case 1: no agent → 4404 surfaces, with a phase-aware message nowhere in sight
{
  const relay = await startRelayServer(0, { noAgentTimeoutMs: 5_000 });
  const code = generateCode();
  const diags = [];
  const client = new RelayTunnelClient({
    serverUrl: `http://127.0.0.1:${relay.port}`,
    code,
    connectTimeoutMs: 3_000, // pre-fix this killed the attempt at 3s
    quiet: true,
    onDiag: (e) => diags.push(e),
  });
  const t0 = Date.now();
  await assert.rejects(
    client.connect(),
    (e) => /4404/.test(e.message),
    "expected the relay's 4404 close to surface in the rejection",
  );
  const waited = Date.now() - t0;
  assert.ok(waited >= 4_500, `the 4404 must come from the server (waited ${waited}ms), not a local timer`);
  const disconnect = diags.find((e) => e.type === "disconnect");
  assert.ok(disconnect, "disconnect diag fired");
  assert.equal(disconnect.code, 4404);
  assert.match(String(disconnect.hint), /no agent registered/i);
  const socketOpen = diags.find((e) => e.type === "socket-open");
  assert.ok(socketOpen, "socket-open diag fired (relay reachable, agent missing)");
  console.log(`ok: agent-offline surfaces 4404 after ${waited}ms (relay reachable, agent missing)`);
  client.close();
  relay.close();
}

// ---- Case 1b: relay unreachable → socket-phase failure, phase reported
{
  const diags = [];
  const client = new RelayTunnelClient({
    serverUrl: "http://127.0.0.1:9", // nothing listens: refused instantly
    code: generateCode(),
    quiet: true,
    onDiag: (e) => diags.push(e),
  });
  await assert.rejects(client.connect(), /Failed to open|Could not open/i);
  const failed = diags.find((e) => e.type === "failed");
  assert.ok(failed, "failed diag fired");
  assert.equal(failed.phase, "socket", "never-opened socket reports phase=socket");
  console.log("ok: unreachable relay reports phase=socket");
  client.close();
}

// ---- Case 2: replaced agent reclaims the pairing (appliance mode)
{
  const relay = await startRelayServer(0);
  const code = generateCode();
  const port = localSvc.address().port;
  const agentA = new RelayAgent({
    serverUrl: `http://127.0.0.1:${relay.port}`,
    code,
    localPort: port,
    deviceName: "appliance",
    quiet: true,
    reclaimMs: 600,
  });
  agentA.start();
  await new Promise((resolve) => {
    const check = () => (agentA.getStatus().state === "connected" ? resolve() : setTimeout(check, 20));
    check();
  });

  const agentB = new RelayAgent({
    serverUrl: `http://127.0.0.1:${relay.port}`,
    code,
    localPort: port,
    deviceName: "preemptor",
    quiet: true,
  });
  agentB.start();
  // Observe the takeover FAST: A reclaims 600ms after being replaced, and
  // that very reclaim kicks B — so B is only briefly "connected" here.
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (agentB.getStatus().state === "connected" && agentA.getStatus().state === "replaced") return resolve();
      if (Date.now() - t0 > 3_000) return reject(new Error(`takeover never observed (B: ${agentB.getStatus().state}, A: ${agentA.getStatus().state})`));
      setTimeout(check, 10);
    };
    check();
  });

  agentB.stop(); // the preemptor goes away — A must take the pairing back
  const deadline = Date.now() + 5_000;
  await new Promise((resolve, reject) => {
    const check = () => {
      if (agentA.getStatus().state === "connected") return resolve();
      if (Date.now() > deadline) return reject(new Error(`A never reclaimed (state: ${agentA.getStatus().state})`));
      setTimeout(check, 50);
    };
    check();
  });

  // and the reclaimed pairing actually carries traffic
  const phone = new RelayTunnelClient({ serverUrl: `http://127.0.0.1:${relay.port}`, code, quiet: true });
  await phone.connect();
  const res = await phone.fetch("/");
  assert.equal(res.status, 200);
  console.log("ok: replaced agent reclaimed the pairing after the preemptor left; tunnel works");

  phone.close();
  agentA.stop();
  relay.close();
}

localSvc.close();
process.exit(0);
