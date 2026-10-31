// Live phone-before-agent regression against a deployed relay (CF Workers).
//
//   node test/live-pending.mjs --server http://127.0.0.1:8787 [--proxy http://…]
//
// The client connects and fires its E2E hello while no agent is registered.
// On the Hibernation API the isolate may be evicted between that hello and
// the agent's arrival, so the relay buffers early frames in DO storage —
// they must replay, or both sides wait for the other's hello forever.
import http from "node:http";
import ws from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { RelayAgent } from "../packages/agent/src/index.ts";
import { RelayTunnelClient } from "../packages/client/src/index.ts";
import { generateCode } from "../packages/core/src/index.ts";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const server = arg("server");
if (!server || !/^https?:\/\//.test(server)) {
  console.error("usage: node test/live-pending.mjs --server http://127.0.0.1:8787 [--proxy http://…]");
  process.exit(1);
}
const proxy = arg("proxy"); // applied to BOTH sides when set; omit for direct

const localSvc = http.createServer((req, res) => res.writeHead(200).end("ok"));
await new Promise((r) => localSvc.listen(0, "127.0.0.1", r));

const code = generateCode();

// client FIRST — its hello lands while the relay has no agent
const client = new RelayTunnelClient({
  serverUrl: server,
  code,
  connectTimeoutMs: 20_000,
  // Same injection live.mjs uses: without it the client rides Node's global
  // undici WebSocket, which (unlike curl / the ws lib) fails the direct
  // handshake to CF on some networks — a transport artifact, not a relay bug.
  ...(proxy && {
    WebSocketImpl: class extends ws {
      constructor(url) {
        super(url, { agent: new HttpsProxyAgent(proxy) });
      }
    },
  }),
  onStateChange: (s) => console.log("client:", s),
});
const connecting = client.connect();

// agent joins after the phone is already waiting
await new Promise((r) => setTimeout(r, 1500));
const agent = new RelayAgent({
  serverUrl: server,
  code,
  localPort: localSvc.address().port,
  deviceName: "live-pending",
  proxy,
});
agent.start();

await connecting; // must resolve via buffered-hello replay, not time out
if (client.state !== "ready") throw new Error(`expected ready, got ${client.state}`);
const r = await client.fetch("/");
if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
console.log("ok: early-hello replayed after late agent; fetch works");

client.close();
agent.stop();
process.exit(0);
