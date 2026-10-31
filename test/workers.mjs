// E2E against the REAL Workers implementation (not the Node fixture): boots
// `wrangler dev` (local miniflare: real Durable Object + Hibernation API +
// storage) and runs the live tests against it. This is the coverage CI gets
// for the deployed shape — the fixture in test/fixtures/relay-server.mjs is a
// hand-kept protocol twin and can silently drift from workers/relay/src.
//
//   node test/workers.mjs        (or: npm run test:dev)

import { spawn } from "node:child_process";

const PORT = Number(process.env.RELAY_DEV_PORT ?? 8787);
const SERVER = `http://127.0.0.1:${PORT}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    p.on("error", reject);
  });
}

// process group, so workerd (child of wrangler) dies with it
const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
  cwd: "workers/relay",
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
});
let boot = "";
wrangler.stdout.on("data", (d) => (boot += d));
wrangler.stderr.on("data", (d) => (boot += d));
const kill = () => {
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {}
};
process.on("exit", kill);

// any HTTP answer (404 included) means the worker is accepting connections
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    await fetch(`${SERVER}/`);
    up = true;
  } catch {}
}
if (!up) {
  console.error(`wrangler dev never came up on ${SERVER}:\n${boot}`);
  kill();
  process.exit(1);
}
console.log(`wrangler dev up on ${SERVER}`);

try {
  // --proxy "" forces a DIRECT connection (the default in live.mjs is a
  // developer-machine proxy that CI and most machines don't have)
  await run("node", ["test/live.mjs", "--server", SERVER, "--proxy", ""]);
  await run("node", ["test/live-pending.mjs", "--server", SERVER]);
  console.log("\nWorkers e2e passed ✓  (real DO + hibernation + storage)");
} finally {
  kill();
}
