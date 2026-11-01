// RelayAgent — desktop side. Ported from Alma's MobileRelay client (yy) and
// E2E responder (py) classes (bundled main.js:12308-12548,
// 12187-12305), minus Alma-specific fast paths, push, and OAuth.
//
// Lifecycle: start() → outbound WS to <server>/agent?th=<tokenHash> → register
// → "registered" = connected. Reconnects with backoff; close code 4000
// (another agent took the pairing) parks it in "replaced" until reconnect().

import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { E2E_PATH, E2ESession, deriveRoutingToken, sha256Hex } from "@hsinsekai-nanami/core";
import type { AgentFrame, ClientFrame } from "@hsinsekai-nanami/core";
import { E2EResponder } from "./responder.ts";

export type RelayAgentState = "stopped" | "connecting" | "connected" | "error" | "replaced";

/** Why a connection ended — one short line of attribution, not an essay.
 *  Codes per PROTOCOL.md §9; Node errno from the transport error when there
 *  was one (a bare 1006 close usually hides ECONNREFUSED / TLS / DNS). */
function classifyDisconnect(code: number | null, errCode: string | null, error: string | null): string {
  if (errCode === "ECONNREFUSED") return "connection refused — wrong server URL/port, or relay down";
  if (errCode === "ENOTFOUND" || errCode === "EAI_AGAIN") return "DNS lookup failed — check the server hostname";
  if (errCode === "ETIMEDOUT") return "timed out reaching the relay — blocked or slow network path";
  if (errCode === "ECONNRESET" || errCode === "EPIPE") return "connection reset mid-path — proxy/firewall cut it; a retry usually recovers";
  if (errCode && /CERT|TLS|EPROTO/.test(errCode)) return "TLS failed — certificate problem or a TLS-intercepting middlebox";
  switch (code) {
    case 1000:
      return "closed normally";
    case 1001:
      return "relay went away — server shutdown or redeploy";
    case 1006:
      return "socket died without a close frame — network switch, NAT idle timeout, or blocked path (a proxy may fix it)";
    case 1015:
      return "TLS handshake failed — TLS-intercepting middlebox or wrong scheme";
    case 4000:
      return "another agent took this pairing — reconnect() to reclaim it";
    case 1011:
      return "relay internal error";
  }
  if (code !== null && code >= 4000 && code < 5000) return "relay policy rejection — see PROTOCOL.md §9";
  if (error) return "transport error — see the message above";
  return "unexpected close — see PROTOCOL.md §9";
}

/** Connection diagnostics: every attempt, failure, and takeover is reported
 *  here and (unless `quiet`) as a one-line `[RelayAgent]` console message.
 *  Field names stay flat and greppable. */
export type RelayDiagEvent =
  | { type: "connect"; server: string; proxy: string | null; attempt: number }
  | { type: "connected"; attempt: number; ms: number }
  | {
      type: "disconnect";
      code: number | null; // WS close code (1006 when the transport died silently), null if we never got a socket
      reason: string | null; // close reason text when the server sent one
      error: string | null; // transport/protocol error message, e.g. "connect ECONNREFUSED 127.0.0.1:9"
      hint: string; // one-line attribution from the disconnect classifier
      lastedMs: number | null; // how long this connection had been up (null = never connected)
      nextRetryMs: number | null; // scheduled backoff before the next attempt (null = no retry: stopped/replaced)
      attempt: number; // which attempt just died (1-based, resets after a successful connect)
    }
  | { type: "replaced"; hint: string; lastedMs: number | null }
  | { type: "heartbeat-missed"; lastedMs: number | null };

export interface RelayAgentConfig {
  serverUrl: string;
  code: string;
  localPort: number;
  deviceName?: string;
  /** HTTP(S) proxy for reaching the relay, e.g. http://127.0.0.1:7897 — needed
   *  where *.workers.dev is unreachable directly. Falls back to env proxy vars. */
  proxy?: string;
  /** Appliance mode: after a 4000 takeover, re-register and reclaim the
   *  pairing after this delay instead of parking in "replaced" until an
   *  explicit reconnect(). Default 0 = spec behavior (park). Escalates ×2 per
   *  reclaim that is itself replaced within RECLAIM_STABLE_MS, capped at
   *  reclaimMaxMs — two always-on reclaiming agents trade the pairing at a
   *  widening interval instead of thrashing. */
  reclaimMs?: number;
  reclaimMaxMs?: number;
  onStateChange?: (status: RelayAgentStatus) => void;
  /** Connection diagnostics (connect/connected/disconnect/replaced/heartbeat-missed).
   *  Fires regardless of `quiet`. */
  onDiag?: (e: RelayDiagEvent) => void;
  /** Silence the default `[RelayAgent]` console lines. onDiag still fires. */
  quiet?: boolean;
}

export interface RelayAgentStatus {
  state: RelayAgentState;
  lastError: string | null;
  connectedAt: number | null;
  activeTunnels: number;
}

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_MS = 15_000;
const BACKPRESSURE_BYTES = 16 * 1024 * 1024;
const CHUNK_SIZE = 32_768;
const DEFAULT_RECLAIM_MAX_MS = 10 * 60_000;
// a registration that held this long counts as stable: the next takeover is a
// fresh event, so the reclaim backoff starts over instead of growing forever
const RECLAIM_STABLE_MS = 60_000;

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class RelayAgent {
  #config: RelayAgentConfig;
  #ws: WebSocket | null = null;
  #state: RelayAgentState = "stopped";
  #lastError: string | null = null;
  #connectedAt: number | null = null;
  #stopped = true;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectDelay = BASE_RECONNECT_MS;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #reclaimTimer: NodeJS.Timeout | null = null;
  #reclaimDelay = 0;
  #httpAborts = new Map<string, AbortController>();
  #localSockets = new Map<string, WebSocket>();
  #responders = new Map<string, E2EResponder>();
  #attempt = 0; // 1-based; reset after a successful connect and on explicit reconnect()
  #connectStartedAt: number | null = null;
  #lastWsError: string | null = null; // transport error message from the socket that just died
  #lastErrCode: string | null = null; // Node errno (ECONNREFUSED, …) behind it

  constructor(config: RelayAgentConfig) {
    this.#config = config;
  }

  getStatus(): RelayAgentStatus {
    return {
      state: this.#state,
      lastError: this.#lastError,
      connectedAt: this.#connectedAt,
      activeTunnels: this.#responders.size + this.#localSockets.size,
    };
  }

  #setState(state: RelayAgentState) {
    if (this.#state !== state) {
      this.#state = state;
      try {
        this.#config.onStateChange?.(this.getStatus());
      } catch (e) {
        console.warn("[RelayAgent] onStateChange threw:", e);
      }
    }
  }

  // every diag event goes to the console (one line, unless quiet) and to
  // onDiag (always; user callbacks must never break the agent)
  #diag(e: RelayDiagEvent) {
    if (!this.#config.quiet) {
      if (e.type === "connect") {
        console.log(`[RelayAgent] connect attempt ${e.attempt} → ${hostOf(e.server)} (proxy: ${e.proxy ?? "none"})`);
      } else if (e.type === "connected") {
        console.log(`[RelayAgent] connected to relay server (attempt ${e.attempt}, ${e.ms} ms)`);
      } else if (e.type === "disconnect") {
        const cause = e.error ?? `close ${e.code}`;
        const retry = e.nextRetryMs != null ? ` — retrying in ${e.nextRetryMs} ms` : "";
        const lasted = e.lastedMs != null ? ` after ${fmtDuration(e.lastedMs)}` : "";
        console.warn(`[RelayAgent] disconnected${lasted} (attempt ${e.attempt}): ${cause} — ${e.hint}${retry}`);
      } else if (e.type === "replaced") {
        const lasted = e.lastedMs != null ? ` after ${fmtDuration(e.lastedMs)}` : "";
        console.warn(`[RelayAgent] disconnected${lasted}: ${e.hint}`);
      } else {
        const lasted = e.lastedMs != null ? ` after ${fmtDuration(e.lastedMs)}` : "";
        console.warn(`[RelayAgent] relay stopped answering pings${lasted} — reconnecting`);
      }
    }
    try {
      this.#config.onDiag?.(e);
    } catch (e2) {
      console.warn("[RelayAgent] onDiag threw:", e2);
    }
  }

  // "" (live.mjs's `--proxy ""` = force-direct, or an empty env var) is no
  // proxy — normalizing here keeps both the socket path and the diag line
  // truthful instead of printing a baffling "(proxy: )"
  #resolveProxy(): string | null {
    const p = this.#config.proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? null;
    return p && p.trim() ? p : null;
  }

  start() {
    this.#stopped = false;
    void this.#connect();
  }

  reconnect() {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer), (this.#reconnectTimer = null);
    if (this.#reclaimTimer) clearTimeout(this.#reclaimTimer), (this.#reclaimTimer = null);
    this.#reconnectDelay = BASE_RECONNECT_MS;
    this.#attempt = 0; // user-initiated: a fresh attempt series
    this.#stopped = false;
    this.#stopHeartbeat();
    if (this.#ws) {
      const old = this.#ws;
      this.#ws = null;
      try {
        old.close(1000, "Reconnecting");
      } catch {}
    }
    this.#teardownTunnels();
    this.#connectedAt = null;
    void this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#stopHeartbeat();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer), (this.#reconnectTimer = null);
    if (this.#reclaimTimer) clearTimeout(this.#reclaimTimer), (this.#reclaimTimer = null);
    this.#teardownTunnels();
    if (this.#ws) {
      try {
        this.#ws.close(1000, "Relay disabled");
      } catch {}
      this.#ws = null;
    }
    this.#setState("stopped");
    this.#connectedAt = null;
  }

  async #connect() {
    if (this.#stopped) return;
    this.#setState("connecting");
    this.#attempt += 1;
    this.#connectStartedAt = Date.now();
    // the proxy line matters: with env vars in play, users often don't know
    // whether they're actually going direct or through a proxy
    this.#diag({ type: "connect", server: this.#config.serverUrl, proxy: this.#resolveProxy(), attempt: this.#attempt });
    try {
      const routingToken = await deriveRoutingToken(this.#config.code);
      const tokenHash = await sha256Hex(routingToken);
      this.#openSocket(tokenHash);
    } catch (e) {
      this.#onDisconnect(e instanceof Error ? e.message : String(e));
    }
  }

  #openSocket(tokenHash: string) {
    if (this.#stopped) return;
    this.#lastWsError = null;
    this.#lastErrCode = null;
    const base = this.#config.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    const proxy = this.#resolveProxy();
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    const ws = new WebSocket(`${base}/agent?th=${tokenHash}`, { maxPayload: 268435456, ...(agent ? { agent } : {}) });
    this.#ws = ws;
    ws.on("open", () => {
      this.#startHeartbeat(ws);
      this.#send({ t: "register", tokenHash, name: this.#config.deviceName || "relay-agent" });
    });
    ws.on("message", (data) => {
      let frame: any;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.#handleFrame(frame);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#stopHeartbeat();
      if (code === 4000) {
        this.#onReplaced();
        return;
      }
      // a transport error (ECONNREFUSED, TLS, …) says more than the bare 1006
      // close that follows it — prefer it when the socket produced one
      const error =
        code === 1000 ? null : this.#lastWsError ?? `Relay connection closed (${code}${reason?.length ? `: ${reason}` : ""})`;
      this.#onDisconnect(error, { code, reason: reason?.length ? reason.toString() : null, errCode: this.#lastErrCode });
    });
    ws.on("error", (e: Error) => {
      this.#lastError = e.message;
      this.#lastWsError = e.message;
      this.#lastErrCode = (e as NodeJS.ErrnoException).code ?? null;
    });
  }

  #startHeartbeat(ws: WebSocket) {
    this.#stopHeartbeat();
    let missed = false;
    ws.on("pong", () => {
      missed = false;
    });
    this.#heartbeatTimer = setInterval(() => {
      if (this.#ws === ws && ws.readyState === WebSocket.OPEN) {
        if (missed) {
          this.#diag({ type: "heartbeat-missed", lastedMs: this.#connectedAt ? Date.now() - this.#connectedAt : null });
          ws.terminate();
          return;
        }
        missed = true;
        try {
          ws.ping();
        } catch {}
      }
    }, HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer), (this.#heartbeatTimer = null);
  }

  #onReplaced() {
    const hint = "another agent took over this pairing — call reconnect() to reclaim it";
    this.#teardownTunnels();
    const lastedMs = this.#connectedAt ? Date.now() - this.#connectedAt : null;
    this.#connectedAt = null;
    this.#diag({ type: "replaced", hint, lastedMs });
    if (this.#stopped) {
      this.#setState("stopped");
      return;
    }
    // Appliance mode: the preemptor is usually a zombie (a laptop that ran
    // with the same code once, a crashed leftover socket). Re-register after
    // a delay and take the pairing back; escalate if it is contested.
    const reclaimMs = this.#config.reclaimMs ?? 0;
    if (reclaimMs > 0) {
      if (lastedMs === null || lastedMs >= RECLAIM_STABLE_MS) this.#reclaimDelay = reclaimMs;
      else this.#reclaimDelay = this.#reclaimDelay > 0 ? Math.min(this.#reclaimDelay * 2, this.#config.reclaimMaxMs ?? DEFAULT_RECLAIM_MAX_MS) : reclaimMs;
      if (!this.#config.quiet) console.warn(`[RelayAgent] reclaiming the pairing in ${Math.round(this.#reclaimDelay / 1000)} s (reclaimMs)`);
      this.#reclaimTimer = setTimeout(() => {
        this.#reclaimTimer = null;
        this.reconnect();
      }, this.#reclaimDelay);
    }
    this.#lastError = "Another agent took over this pairing";
    this.#setState("replaced");
  }

  #onDisconnect(
    error: string | null,
    close: { code: number; reason: string | null; errCode: string | null } | null = null,
  ) {
    this.#teardownTunnels();
    const lastedMs = this.#connectedAt ? Date.now() - this.#connectedAt : null;
    this.#connectedAt = null;
    if (error) {
      this.#lastError = error;
      this.#setState("error");
    }
    this.#diag({
      type: "disconnect",
      code: close?.code ?? null,
      reason: close?.reason ?? null,
      error,
      hint: classifyDisconnect(close?.code ?? null, close?.errCode ?? null, error),
      lastedMs,
      nextRetryMs: this.#stopped ? null : this.#reconnectDelay,
      attempt: this.#attempt,
    });
    if (this.#stopped) {
      this.#setState("stopped");
      return;
    }
    if (this.#state !== "error") this.#setState("connecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, this.#reconnectDelay);
    this.#reconnectDelay = Math.min(2 * this.#reconnectDelay, MAX_RECONNECT_MS);
  }

  #teardownTunnels() {
    for (const a of this.#httpAborts.values()) a.abort();
    this.#httpAborts.clear();
    for (const s of this.#localSockets.values()) {
      try {
        s.close();
      } catch {}
    }
    this.#localSockets.clear();
    for (const r of this.#responders.values()) r.destroy();
    this.#responders.clear();
  }

  #send(frame: AgentFrame | { t: string; [k: string]: unknown }) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  async #waitForDrain() {
    while (this.#ws && this.#ws.readyState === WebSocket.OPEN && this.#ws.bufferedAmount > BACKPRESSURE_BYTES) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  #handleFrame(frame: any) {
    switch (frame.t) {
      case "registered":
        this.#lastError = null;
        this.#connectedAt = Date.now();
        this.#setState("connected");
        this.#reconnectDelay = BASE_RECONNECT_MS;
        this.#diag({
          type: "connected",
          attempt: this.#attempt,
          ms: this.#connectStartedAt ? Date.now() - this.#connectStartedAt : 0,
        });
        this.#attempt = 0; // a later failure starts a fresh 1-based series
        break;
      case "error":
        this.#lastError = String(frame.message || "Relay error");
        this.#setState("error");
        if (!this.#config.quiet) console.error("[RelayAgent] Relay rejected connection:", this.#lastError);
        break;
      case "hreq":
        void this.#proxyHttp(frame);
        break;
      case "hcancel": {
        const a = this.#httpAborts.get(String(frame.id));
        if (a) {
          this.#httpAborts.delete(String(frame.id));
          a.abort();
        }
        break;
      }
      case "wopen": {
        const id = String(frame.id);
        const path = String(frame.path || "/");
        if (path === E2E_PATH || path.startsWith(`${E2E_PATH}?`)) this.#openE2EResponder(id);
        else this.#openLocalSocket(id, path);
        break;
      }
      case "wmsg": {
        const id = String(frame.id);
        const responder = this.#responders.get(id);
        if (responder) {
          if (typeof frame.s === "string") void responder.onMessage(frame.s);
          else if (typeof frame.b === "string") void responder.onMessage(new Uint8Array(Buffer.from(frame.b, "base64")));
          return;
        }
        const local = this.#localSockets.get(id);
        if (!local || local.readyState !== WebSocket.OPEN) return;
        if (typeof frame.s === "string") local.send(frame.s);
        else if (typeof frame.b === "string") local.send(Buffer.from(frame.b, "base64"));
        break;
      }
      case "wclose": {
        const id = String(frame.id);
        const responder = this.#responders.get(id);
        if (responder) {
          this.#responders.delete(id);
          responder.destroy();
          return;
        }
        const local = this.#localSockets.get(id);
        if (!local) return;
        this.#localSockets.delete(id);
        try {
          local.close();
        } catch {}
        break;
      }
    }
  }

  #openE2EResponder(id: string) {
    const responder = new E2EResponder({
      code: this.#config.code,
      localPort: this.#config.localPort,
      send: (data) => {
        if (typeof data === "string") this.#send({ t: "wmsg", id, s: data });
        else this.#send({ t: "wmsg", id, b: Buffer.from(data).toString("base64") });
      },
      onError: (e) => console.error("[RelayAgent] E2E tunnel error:", e),
    });
    this.#responders.set(id, responder);
    this.#send({ t: "wopened", id });
  }

  async #proxyHttp(frame: any) {
    const { id } = frame;
    const abort = new AbortController();
    this.#httpAborts.set(String(id), abort);
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(frame.headers || {})) {
        const lower = k.toLowerCase();
        if (lower !== "host" && lower !== "connection" && lower !== "content-length" && lower !== "accept-encoding" && typeof v === "string") {
          headers[lower] = v;
        }
      }
      headers["accept-encoding"] = "identity";
      const method = (frame.method || "GET").toUpperCase();
      const body = frame.b && method !== "GET" && method !== "HEAD" ? Buffer.from(frame.b, "base64") : undefined;
      const res = await fetch(`http://127.0.0.1:${this.#config.localPort}${frame.path}`, {
        method,
        headers,
        body,
        signal: abort.signal,
        redirect: "manual",
      });
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (lower !== "connection" && lower !== "keep-alive" && lower !== "transfer-encoding") resHeaders[lower] = v;
      });
      this.#send({ t: "hres", id, status: res.status, headers: resHeaders });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!this.#httpAborts.has(String(id))) return;
          for (let o = 0; o < value.length; o += CHUNK_SIZE) {
            await this.#waitForDrain();
            this.#send({ t: "hchunk", id, b: Buffer.from(value.subarray(o, o + CHUNK_SIZE)).toString("base64") });
          }
        }
      }
      this.#send({ t: "hend", id });
    } catch (e) {
      // hcancel aborts land here too: per PROTOCOL.md §4 the agent answers a
      // cancelled request with herr("cancelled") on a best-effort basis
      // (the client may already have settled locally — it ignores the frame).
      this.#send({
        t: "herr",
        id,
        message: abort.signal.aborted ? "cancelled" : e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.#httpAborts.delete(String(id));
    }
  }

  #openLocalSocket(id: string, path: string) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.#config.localPort}${path}`);
    } catch (e) {
      this.#send({ t: "werr", id, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.#localSockets.set(id, ws);
    ws.on("open", () => this.#send({ t: "wopened", id }));
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        this.#send({ t: "wmsg", id, b: buf.toString("base64") });
      } else {
        this.#send({ t: "wmsg", id, s: data.toString() });
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (this.#localSockets.has(id)) {
        this.#localSockets.delete(id);
        this.#send({ t: "wclose", id, code, reason: reason?.toString() });
      }
    });
    ws.on("error", (e: Error) => {
      if (this.#localSockets.has(id) && ws.readyState === WebSocket.CONNECTING) {
        this.#localSockets.delete(id);
        this.#send({ t: "werr", id, message: e.message });
      }
    });
  }
}

export { E2EResponder } from "./responder.ts";
