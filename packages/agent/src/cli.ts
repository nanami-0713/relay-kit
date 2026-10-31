#!/usr/bin/env node
// relay-agent CLI — pair a local HTTP/WS service with a relay server.
//
//   relay-agent --server https://relay.example.workers.dev --code <code> --port 3425
//                [--proxy http://127.0.0.1:7897]
//
// --code omitted → a fresh 256-bit code is generated and printed (with the
// phone-side connect URL). Point it at any local service (e.g. --port 3425 for a local gateway).

import os from "node:os";
import { RelayAgent } from "./index.ts";
import { deriveRoutingToken, generateCode } from "@hsinsekai-nanami/core";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const server = arg("server");
if (!server) {
  console.error(
    "usage: relay-agent --server <https://relay.example.workers.dev> [--code <code>] [--port <n>] [--name <name>] [--proxy <http://...>]",
  );
  process.exit(1);
}
const port = Number(arg("port") ?? 3425);
const providedCode = arg("code");
const code = providedCode ?? generateCode();

if (!providedCode) {
  const rt = await deriveRoutingToken(code);
  console.log(`
Pairing code (new, shown once):
  ${code}

Phone connect path on this relay:
  /c/${rt}/__alma_e2e__
`);
}

const agent = new RelayAgent({
  serverUrl: server,
  code,
  localPort: port,
  deviceName: arg("name") ?? os.hostname(),
  proxy: arg("proxy"),
  onStateChange: (s) => console.log(`[state] ${s.state}${s.lastError ? ` (${s.lastError})` : ""}`),
});
agent.start();

const shutdown = () => {
  agent.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
