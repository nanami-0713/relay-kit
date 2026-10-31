// Live test against a deployed relay (CF Workers).
//
//   node test/live.mjs --server https://<your-relay>.workers.dev
//
// Verifies the real-Workers path end to end: agent (this machine) registers,
// a local client opens the E2E tunnel through the deployed relay, and an
// HTTP GET round-trips to a local fixture service.

import http from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import ws from "ws";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { generateCode } from "../packages/core/src/index.ts";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const server = arg("server");
if (!server || !/^https?:\/\//.test(server)) {
  console.error("usage: node test/live.mjs --server https://<your-relay>.workers.dev");
  process.exit(1);
}

// 1. Local fixture service ("fake local service").
const svc = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((r) => svc.listen(0, "127.0.0.1", r));
const svcPort = svc.address().port;
console.log(`local service on :${svcPort}`);

// 2. Agent → deployed relay (via proxy: workers.dev may be unreachable
//    directly on some networks; pass --proxy "" to force a direct connection).
const proxy = arg("proxy") ?? "http://127.0.0.1:7897";
const code = generateCode();
const agent = new RelayAgent({ serverUrl: server, code, localPort: svcPort, deviceName: "live-test", proxy });
agent.start();
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const check = () => {
    const s = agent.getStatus().state;
    if (s === "connected") return resolve();
    if (Date.now() - t0 > 30_000) return reject(new Error(`agent never connected (state=${s}, err=${agent.getStatus().lastError})`));
    setTimeout(check, 100);
  };
  check();
});
console.log(`agent connected to ${server} (${Date.now() - t0}ms)`);

// 3. Phone-side client → deployed relay → tunnel → local service.
//    Inject the ws library with a proxy agent (browsers/Capacitor would use
//    the platform's own network stack). `--proxy ""` = direct connection
//    (local wrangler dev).
const proxyAgent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const phone = new RelayTunnelClient({
  serverUrl: server,
  code,
  ...(proxyAgent && {
    WebSocketImpl: class extends ws {
      constructor(url) {
        super(url, { agent: proxyAgent });
      }
    },
  }),
  onStateChange: (s, d) => console.log(`phone: ${s}${d ? ` (${d})` : ""}`),
});
try {
  await phone.connect();
  const res = await phone.fetch("/live-check", { headers: { accept: "application/json" } });
  const body = res.json();
  if (res.status !== 200 || body.path !== "/live-check") throw new Error(`unexpected response: ${res.status} ${JSON.stringify(body)}`);
  console.log("LIVE TEST PASSED ✓  (E2E tunnel through the deployed relay works)");
  process.exitCode = 0;
} catch (e) {
  console.error("LIVE TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  phone.close();
  agent.stop();
  svc.close();
  setTimeout(() => process.exit(process.exitCode), 200);
}
