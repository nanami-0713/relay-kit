// Node fixture relay server — protocol-identical reference implementation of
// the Cloudflare Worker (workers/relay/src/index.ts), used by the test suite.
// Also usable as a self-hosted relay if you ever want one process + ws.

import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export function startRelayServer(port = 0, opts = {}) {
  // How long a phone with no registered agent waits before the server closes
  // it with 4404 (PROTOCOL §5 says 60s; tests shrink it to stay fast).
  const NO_AGENT_TIMEOUT_MS = opts.noAgentTimeoutMs ?? 60_000;
  const server = http.createServer((req, res) => {
    res.writeHead(404).end("not found");
  });
  const wss = new WebSocketServer({ noServer: true });

  // tokenHash -> { agent: ws|null, phones: Map<tunnelId, ws>, pending: ws[] }
  const rooms = new Map();
  const pendingDeadlines = new Map();
  let nextId = 0;

  const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
// parity with the Worker: caps that a legit handshake (<1 KB) never touches
const EARLY_MAX_FRAMES = 256;
const EARLY_MAX_BYTES = 64 * 1024;

  function roomFor(th) {
    let r = rooms.get(th);
    if (!r) rooms.set(th, (r = { agent: null, phones: new Map(), pending: [] }));
    return r;
  }

  function openTunnel(room, ws) {
    const id = `t${++nextId}`;
    room.phones.set(id, ws);
    pendingDeadlines.delete(ws);
    const onMessage = (data, isBinary) => {
      if (!room.agent || room.agent.readyState !== WebSocket.OPEN) return;
      if (isBinary) room.agent.send(JSON.stringify({ t: "wmsg", id, b: data.toString("base64") }));
      else room.agent.send(JSON.stringify({ t: "wmsg", id, s: data.toString() }));
    };
    ws.on("message", onMessage);
    const onClose = () => {
      if (room.phones.get(id) === ws) room.phones.delete(id);
      if (room.agent && room.agent.readyState === WebSocket.OPEN) {
        room.agent.send(JSON.stringify({ t: "wclose", id, code: 1000 }));
      }
    };
    ws.on("close", onClose);
    ws.on("error", onClose);
    room.agent.send(JSON.stringify({ t: "wopen", id, path: "/__alma_e2e__" }));
    // A phone that arrived while no agent was up started its E2E hello into
    // the void — those early frames were buffered (ws.__early). Replay them
    // only AFTER wopen: the agent drops wmsgs for tunnels it hasn't opened.
    if (ws.__earlyFn) {
      ws.removeListener("message", ws.__earlyFn);
      for (const [data, isBinary] of ws.__early.splice(0)) onMessage(data, isBinary);
      ws.__earlyFn = null;
      ws.__early = null;
    }
  }

  const sweepPending = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) {
      r.pending = r.pending.filter((ws) => {
        const deadline = pendingDeadlines.get(ws) ?? 0;
        if (now < deadline) return true;
        pendingDeadlines.delete(ws);
        try {
          ws.close(4404, "No agent connected for this pairing");
        } catch {}
        return false;
      });
    }
  }, 5_000);
  sweepPending.unref();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    let th = null;
    let role = null;
    if (url.pathname === "/agent") {
      const q = url.searchParams.get("th") ?? "";
      if (!/^[0-9a-f]{64}$/.test(q)) {
        socket.destroy();
        return;
      }
      th = q;
      role = "agent";
    } else {
      const m = url.pathname.match(/^\/c\/([A-Za-z0-9_-]{16,64})\/__alma_e2e__\/?$/);
      if (!m) {
        socket.destroy();
        return;
      }
      th = sha256Hex(m[1]);
      role = "phone";
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = roomFor(th);
      if (role === "agent") {
        ws.on("message", (data) => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          switch (msg.t) {
            case "register": {
              if (room.agent && room.agent !== ws) {
                try {
                  room.agent.close(4000, "Another agent took over this pairing");
                } catch {}
              }
              room.agent = ws;
              ws.send(JSON.stringify({ t: "registered" }));
              for (const p of room.pending) openTunnel(room, p);
              room.pending = [];
              break;
            }
            case "wmsg": {
              const phone = room.phones.get(String(msg.id));
              if (!phone || phone.readyState !== WebSocket.OPEN) return;
              if (typeof msg.s === "string") phone.send(msg.s);
              else if (typeof msg.b === "string") {
                const buf = Buffer.from(msg.b, "base64");
                phone.send(buf);
              }
              break;
            }
            case "wclose": {
              const phone = room.phones.get(String(msg.id));
              if (phone) {
                room.phones.delete(String(msg.id));
                try {
                  phone.close(msg.code ?? 1000, String(msg.reason ?? ""));
                } catch {}
              }
              break;
            }
          }
        });
        const onAgentClose = () => {
          if (room.agent !== ws) return;
          room.agent = null;
          for (const [, phone] of room.phones) {
            try {
              phone.close(1011, "agent disconnected");
            } catch {}
          }
          room.phones.clear();
        };
        ws.on("close", onAgentClose);
        ws.on("error", onAgentClose);
      } else {
        if (!room.agent || room.agent.readyState !== WebSocket.OPEN) {
          room.pending.push(ws);
          pendingDeadlines.set(ws, Date.now() + NO_AGENT_TIMEOUT_MS);
          // buffer, don't drop: the E2E initiator sends its hello the moment
          // its socket opens — without this the frame is lost, and the agent
          // that arrives later waits for a hello that already vanished
          ws.__early = [];
          ws.__earlyFn = (data, isBinary) => {
            const buffered = ws.__early.reduce((n, [d]) => n + (d?.length ?? 0), 0);
            if (ws.__early.length >= EARLY_MAX_FRAMES || buffered + (data?.length ?? 0) > EARLY_MAX_BYTES) return;
            ws.__early.push([data, isBinary]);
          };
          ws.on("message", ws.__earlyFn);
          ws.on("close", () => {
            room.pending = room.pending.filter((p) => p !== ws);
            pendingDeadlines.delete(ws);
          });
          return;
        }
        openTunnel(room, ws);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => {
          clearInterval(sweepPending);
          for (const r of rooms.values()) {
            try {
              r.agent?.close(1001);
            } catch {}
            for (const [, p] of r.phones) try { p.close(1001); } catch {}
          }
          wss.close();
          server.close();
        },
      });
    });
  });
}
