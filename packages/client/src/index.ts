// RelayTunnelClient — the phone/browser side. Connects to the relay, completes
// the E2E handshake as initiator, then exposes fetch() and a WebSocket-like
// stream over the encrypted tunnel. Ported from Alma's RelayE2EClient
// (renderer chunk connected-D8mcBngn.js:1041+) plus the fetch-over-tunnel
// helpers distilled in test/smoke.mjs.
//
// Transport injection keeps it usable from Capacitor/WebView: pass any
// WebSocket constructor with the standard event API.

import { E2ESession, deriveRoutingToken } from "@hsinsekai-nanami/core";

export type TunnelState = "idle" | "connecting" | "ready" | "error" | "closed";

/** Why a tunnel died — one short line of attribution (close codes per
 *  PROTOCOL.md §9). Browsers hide transport errors, so on the client the
 *  close code is usually all there is to go on. */
function closeHint(code: number | null, reason: string | null): string {
  switch (code) {
    case 1000:
      return "closed normally";
    case 1001:
      return "relay went away — server shutdown or redeploy";
    case 1006:
      return "socket died without a close frame — radio drop, network switch, or NAT idle timeout; reconnect";
    case 1011:
      return "agent disconnected — the desktop side went offline; retry once it is back";
    case 1015:
      return "TLS handshake failed — TLS-intercepting middlebox or wrong scheme";
    case 4404:
      return "no agent registered for this pairing — is the desktop agent running, and is the code right?";
  }
  if (code !== null && code >= 4000 && code < 5000) return "relay policy rejection — see PROTOCOL.md §9";
  if (reason) return `relay said: ${reason}`;
  return "unexpected close — see PROTOCOL.md §9";
}

function failHint(error: string): string {
  if (/timed out/i.test(error)) return "relay unreachable or slow — check the server URL and network path";
  if (/authentication failed|auth-failed/i.test(error)) return "handshake rejected — wrong pairing code";
  if (/Failed to open/i.test(error)) return "could not open the WebSocket — bad server URL, blocked network, or TLS issue";
  if (/went silent/i.test(error)) return "no frame for idleTimeoutMs — radio sleep or half-dead socket; reconnect and retry";
  if (/disconnected during pairing/i.test(error)) return "close() or a newer connect() interrupted this attempt";
  if (/not connected/i.test(error)) return "tunnel was already down";
  return "see PROTOCOL.md §9 and the relay's own logs (wrangler tail)";
}

/** Connection diagnostics (the client-side counterpart of the agent's
 *  RelayDiagEvent, minimal): every event also lands on the console as a
 *  `[RelayClient]` line unless `quiet` is set. */
export type TunnelDiagEvent =
  | { type: "connect"; server: string }
  | { type: "ready"; ms: number }
  | {
      type: "disconnect"; // the WS closed (with a close frame or 1006)
      code: number | null;
      reason: string | null;
      error: string | null; // composed message, e.g. "Relay tunnel closed (1011 agent disconnected)"
      hint: string;
      lastedMs: number | null; // how long the tunnel had been ready (null = it never got there)
      byUser: boolean;
    }
  | { type: "failed"; error: string; hint: string; byUser: boolean }; // establishment/watchdog/handshake failure — no close code to read

export interface RelayTunnelClientOpts {
  serverUrl: string; // https://relay.example.workers.dev
  code: string; // pairing code shared with the agent
  WebSocketImpl?: typeof WebSocket;
  connectTimeoutMs?: number;
  // A phone's radio can drop without a close frame ever arriving, leaving a
  // request pending forever. While anything is pending, a tunnel this quiet
  // for idleTimeoutMs is declared dead and everything on it fails — the app
  // is then expected to connect() again. Browsers can't send WS pings, so
  // "no frame arrived" is the only liveness signal there is.
  idleTimeoutMs?: number;
  onStateChange?: (state: TunnelState, detail?: string) => void;
  /** Connection diagnostics (connect/ready/disconnect/failed). Fires
   *  regardless of `quiet`. */
  onDiag?: (e: TunnelDiagEvent) => void;
  /** Silence the default `[RelayClient]` console lines. onDiag still fires. */
  quiet?: boolean;
}

interface PendingHttp {
  resolve: (r: TunnelResponse) => void;
  reject: (e: Error) => void;
  status: number;
  headers: Record<string, string>;
  chunks: Uint8Array[];
  onChunk?: (chunk: Uint8Array) => void;
  onHeaders?: (status: number, headers: Record<string, string>) => void;
}

export class TunnelResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  #body: Uint8Array[];
  constructor(status: number, headers: Record<string, string>, body: Uint8Array[]) {
    this.status = status;
    this.headers = headers;
    this.#body = body;
  }
  text(): string {
    return new TextDecoder().decode(this.concat());
  }
  json(): any {
    return JSON.parse(this.text());
  }
  bytes(): Uint8Array {
    return this.concat();
  }
  private concat(): Uint8Array {
    let n = 0;
    for (const c of this.#body) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of this.#body) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

export class TunnelWebSocket {
  #send: (f: any) => void;
  #listeners = { open: new Set<() => void>(), message: new Set<(data: string | Uint8Array) => void>(), close: new Set<() => void>(), error: new Set<(e: string) => void>() };
  onopen: (() => void) | null = null;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: string) => void) | null = null;
  readyState = 0; // 0 connecting, 1 open, 2 closed

  constructor(send: (f: any) => void) {
    this.#send = send;
  }
  #emit(ev: "open" | "close" | "error", arg?: string) {
    (this.#listeners[ev] as Set<any>).forEach((fn: any) => fn(arg));
    (this as any)["on" + ev]?.(arg);
  }
  addEventListener(ev: "open" | "message" | "close" | "error", fn: any) {
    this.#listeners[ev].add(fn);
  }
  removeEventListener(ev: "open" | "message" | "close" | "error", fn: any) {
    this.#listeners[ev].delete(fn);
  }
  send(data: string | Uint8Array) {
    if (this.readyState !== 1) throw new Error("tunnel ws not open");
    if (typeof data === "string") this.#send({ t: "wmsg", id: this.#id, s: data });
    else this.#send({ t: "wmsg", id: this.#id, b: b64u(data) });
  }
  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.#send({ t: "wclose", id: this.#id, code: 1000 });
    this.#emit("close");
  }
  // wired by RelayTunnelClient:
  #id!: string;
  _attach(id: string) {
    this.#id = id;
  }
  _opened() {
    if (this.readyState === 1) return;
    this.readyState = 1;
    this.#emit("open");
  }
  _message(data: string | Uint8Array) {
    for (const fn of this.#listeners.message) fn(data);
    this.onmessage?.(data);
  }
  _error(e: string) {
    this.readyState = 2;
    this.#emit("error", e);
  }
  _closed() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.#emit("close");
  }
}

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export class RelayTunnelClient {
  #opts: RelayTunnelClientOpts;
  #ws: WebSocket | null = null;
  #session: E2ESession | null = null;
  #state: TunnelState = "idle";
  #http = new Map<string, PendingHttp>();
  #sockets = new Map<string, TunnelWebSocket>();
  #readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  #closedByUser = false;
  #connectTimer: any = null;
  #watchdogTimer: any = null;
  #lastFrameAt = 0;
  #epoch = 0;
  #connectStartedAt: number | null = null;
  #readyAt: number | null = null;

  constructor(opts: RelayTunnelClientOpts) {
    this.#opts = opts;
  }

  get state(): TunnelState {
    return this.#state;
  }

  #setState(s: TunnelState, detail?: string) {
    this.#state = s;
    this.#opts.onStateChange?.(s, detail);
  }

  // every diag event goes to the console (one line, unless quiet) and to
  // onDiag (always; user callbacks must never break the client)
  #diag(e: TunnelDiagEvent) {
    if (!this.#opts.quiet) {
      if (e.type === "connect") {
        console.log(`[RelayClient] connecting to ${hostOf(e.server)}`);
      } else if (e.type === "ready") {
        console.log(`[RelayClient] tunnel ready (${e.ms} ms)`);
      } else if (e.type === "disconnect") {
        if (!e.byUser) {
          const lasted = e.lastedMs != null ? ` after ${fmtDuration(e.lastedMs)}` : " before ready";
          const cause = e.error ?? `close ${e.code}`;
          console.warn(`[RelayClient] tunnel closed${lasted}: ${cause} — ${e.hint}`);
        }
      } else {
        if (!e.byUser) console.warn(`[RelayClient] tunnel failed: ${e.error} — ${e.hint}`);
      }
    }
    try {
      this.#opts.onDiag?.(e);
    } catch (e2) {
      console.warn("[RelayClient] onDiag threw:", e2);
    }
  }

  async connect(): Promise<void> {
    if (this.#state === "connecting" || this.#state === "ready") return this.ready();
    this.#closedByUser = false;
    this.#setState("connecting");
    this.#connectStartedAt = Date.now();
    this.#readyAt = null; // a fresh tunnel's lifetime starts from its own ready
    this.#diag({ type: "connect", server: this.#opts.serverUrl });
    const epoch = ++this.#epoch;
    this.#detach(); // a leftover socket from an earlier failed run must not leak frames into this one
    const WS = this.#opts.WebSocketImpl ?? globalThis.WebSocket;
    const routingToken = await deriveRoutingToken(this.#opts.code);
    const ws: WebSocket = new WS(`${this.#opts.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/c/${routingToken}/__alma_e2e__`);
    // Binary frames must arrive as ArrayBuffer, not Blob (WHATWG default) —
    // the session expects raw bytes. Same line exists in Alma's client.
    (ws as any).binaryType = "arraybuffer";
    this.#ws = ws;
    this.#connectTimer = setTimeout(() => {
      this.#fail("Encrypted relay connection timed out");
      try {
        ws.close();
      } catch {}
    }, this.#opts.connectTimeoutMs ?? 20_000);
    const session = new E2ESession({
      role: "initiator",
      code: this.#opts.code,
      send: (data) => ws.send(data as any),
      onReady: () => {
        if (this.#ws !== ws) return;
        clearTimeout(this.#connectTimer);
        this.#lastFrameAt = Date.now();
        this.#readyAt = Date.now();
        this.#startWatchdog();
        this.#setState("ready");
        this.#diag({ type: "ready", ms: this.#connectStartedAt ? Date.now() - this.#connectStartedAt : 0 });
        for (const w of this.#readyWaiters) w.resolve();
        this.#readyWaiters = [];
      },
      onFrame: (f: any) => this.#onFrame(f),
      onError: (m) => this.#fail(m),
    });
    this.#session = session;
    ws.onopen = () => void session.start();
    ws.onmessage = (ev: MessageEvent) => {
      if (this.#ws !== ws) return; // a replaced tunnel's late frames must not touch this one
      const data = ev.data;
      if (typeof data === "string") void session.onMessage(data);
      else if (data instanceof ArrayBuffer) void session.onMessage(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) void session.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.#ws !== ws) return;
      clearTimeout(this.#connectTimer);
      // Carry the code/reason through: "4404 No agent connected" and
      // "1011 agent disconnected" tell the app what actually died, while a
      // bare 1006 means the socket vanished without a word.
      const why = `Relay tunnel closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`;
      this.#handleClose(why, ev.code, ev.reason || null);
    };
    ws.onerror = () => {
      if (this.#ws === ws && this.#state === "connecting") this.#fail("Failed to open relay tunnel");
    };
    if (epoch !== this.#epoch) this.#fail("Client disconnected during pairing");
    return this.ready();
  }

  ready(): Promise<void> {
    if (this.#state === "ready") return Promise.resolve();
    if (this.#state === "error" || this.#state === "closed") return Promise.reject(new Error("E2E tunnel not connected"));
    return new Promise((resolve, reject) => this.#readyWaiters.push({ resolve, reject }));
  }

  close() {
    this.#epoch++;
    this.#closedByUser = true;
    try {
      this.#ws?.close();
    } catch {}
    this.#detach(); // kills onclose, so nothing else will settle these
    clearTimeout(this.#connectTimer);
    this.#stopWatchdog();
    // teardown settles everything in flight: a caller mid-swap relies on its
    // pending fetches rejecting, otherwise a load streaming over the old
    // client waits forever on promises nobody will ever touch again
    this.#rejectPending(new Error("Tunnel closed"));
    for (const w of this.#readyWaiters) w.reject(new Error("Tunnel closed"));
    this.#readyWaiters = [];
    this.#setState("closed");
  }

  // when the last frame arrived — 0 before the first. A tunnel that is
  // "ready" but has heard nothing for a long stretch (a phone slept with the
  // socket dying quietly) is stale; the app can check this on coming back to
  // the foreground and reconnect instead of waiting for the watchdog.
  get lastFrameAt(): number {
    return this.#lastFrameAt;
  }

  // untie the current socket: without this, a failed run's socket keeps its
  // handlers and keeps refreshing #lastFrameAt, masking the next tunnel's
  // silence (and leaking the connection).
  #detach() {
    const ws = this.#ws;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onopen = null;
    }
    this.#ws = null;
    this.#session = null;
  }

  #startWatchdog() {
    this.#stopWatchdog();
    this.#watchdogTimer = setInterval(() => {
      // only HTTP requests count: an open-but-idle socket is a healthy
      // stream, not a wedged request
      if (!this.#http.size || Date.now() - this.#lastFrameAt <= (this.#opts.idleTimeoutMs ?? 45_000)) return;
      this.#fail("Tunnel went silent with a request pending");
      try {
        this.#ws?.close(); // a dead one never fires onclose: fail() already failed everything
      } catch {}
    }, 2_000);
  }

  #stopWatchdog() {
    if (this.#watchdogTimer) clearInterval(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  #fail(message: string) {
    this.#stopWatchdog();
    const ws = this.#ws;
    this.#detach();
    try {
      ws?.close();
    } catch {} // detached: no onclose double-report, and the reason above stands
    this.#rejectPending(new Error(message));
    for (const w of this.#readyWaiters) w.reject(new Error(message));
    this.#readyWaiters = [];
    this.#setState("error", message);
    this.#diag({ type: "failed", error: message, hint: failHint(message), byUser: this.#closedByUser });
  }

  #rejectPending(e: Error) {
    for (const [, p] of this.#http) p.reject(e);
    this.#http.clear();
    for (const [, s] of this.#sockets) s._closed();
    this.#sockets.clear();
  }

  #handleClose(reason: string, code: number | null = null, closeReason: string | null = null) {
    this.#stopWatchdog();
    this.#rejectPending(new Error(reason));
    for (const w of this.#readyWaiters) w.reject(new Error(reason));
    this.#readyWaiters = [];
    this.#setState(this.#closedByUser ? "closed" : "error", reason);
    this.#diag({
      type: "disconnect",
      code,
      reason: closeReason,
      error: reason,
      hint: closeHint(code, closeReason),
      lastedMs: this.#readyAt ? Date.now() - this.#readyAt : null,
      byUser: this.#closedByUser,
    });
  }

  #send(frame: any) {
    void this.#session?.sendFrame(frame);
  }

  #onFrame(f: any) {
    this.#lastFrameAt = Date.now();
    if (f.t === "hres" || f.t === "hchunk" || f.t === "hend" || f.t === "herr") {
      const p = this.#http.get(String(f.id));
      if (!p) return;
      if (f.t === "hres") {
        p.status = f.status;
        p.headers = f.headers;
        p.onHeaders?.(f.status, f.headers);
      } else if (f.t === "hchunk") {
        const bin = atob(f.b);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        p.chunks.push(out);
        p.onChunk?.(out);
      } else if (f.t === "hend") {
        this.#http.delete(String(f.id));
        p.resolve(new TunnelResponse(p.status ?? 0, p.headers ?? {}, p.chunks));
      } else {
        this.#http.delete(String(f.id));
        p.reject(new Error(f.message));
      }
      return;
    }
    if (f.t === "wopened") {
      const s = this.#sockets.get(String(f.id));
      s?._opened();
      return;
    }
    if (f.t === "wmsg") {
      const s = this.#sockets.get(String(f.id));
      if (!s) return;
      if (typeof f.s === "string") s._message(f.s);
      else if (typeof f.b === "string") {
        const bin = atob(f.b);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        s._message(out);
      }
      return;
    }
    if (f.t === "wclose") {
      const s = this.#sockets.get(String(f.id));
      if (s) {
        this.#sockets.delete(String(f.id));
        s._closed();
      }
      return;
    }
    if (f.t === "werr") {
      const s = this.#sockets.get(String(f.id));
      if (s) {
        this.#sockets.delete(String(f.id));
        s._error(f.message);
      }
    }
  }

  /** fetch()-alike over the tunnel. Returns status/headers/body (bodies are
   *  reassembled from hchunk frames). Pass onChunk to also observe body
   *  chunks as they arrive, or onHeaders to observe status/headers as soon as
   *  the response head lands (before the promise resolves) — that pair is
   *  what a streaming consumer needs to build a live Response. Pass an
   *  AbortSignal to cancel: the pending promise rejects immediately and an
   *  hcancel frame tells the agent to stop fetching (the agent's answering
   *  herr("cancelled") is ignored, the pending is already gone). */
  async fetch(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal; onChunk?: (chunk: Uint8Array) => void; onHeaders?: (status: number, headers: Record<string, string>) => void } = {},
  ): Promise<TunnelResponse> {
    await this.ready();
    // the await can resume after a close()/fail() already drained everything:
    // a request registered past that point would never be answered
    if (this.#state === "closed" || this.#state === "error") throw new Error("Tunnel closed");
    const signal = init.signal;
    if (signal?.aborted) throw new Error("aborted");
    const id = `h${Math.random().toString(36).slice(2)}`;
    const method = (init.method ?? "GET").toUpperCase();
    let b: string | undefined;
    if (init.body != null && method !== "GET" && method !== "HEAD") {
      b = typeof init.body === "string" ? b64u(new TextEncoder().encode(init.body)) : b64u(init.body);
    }
    const p = new Promise<TunnelResponse>((resolve, reject) => {
      const entry: PendingHttp = { resolve, reject, status: 0, headers: {}, chunks: [], onChunk: init.onChunk, onHeaders: init.onHeaders };
      if (signal) {
        const onAbort = () => {
          if (!this.#http.delete(id)) return; // already settled by a frame
          this.#send({ t: "hcancel", id });
          entry.reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // settle through wrappers so a normally-completed request removes its
        // own listener instead of pinning signal → entry for the app's lifetime
        const wrap = (fn: (v: never) => void) => ((v: never) => { signal.removeEventListener("abort", onAbort); fn(v); }) as typeof fn;
        entry.resolve = wrap(resolve as (v: never) => void) as typeof resolve;
        entry.reject = wrap(reject as (e: never) => void) as typeof reject;
      }
      this.#http.set(id, entry);
    });
    this.#send({ t: "hreq", id, method, path, headers: init.headers ?? {}, b });
    return p;
  }

  /** Open a WebSocket-like stream over the tunnel to ws://127.0.0.1:<port><path>.
   *  Resolves once the agent confirms the local socket is open. */
  async openSocket(path: string): Promise<TunnelWebSocket> {
    await this.ready();
    // same resume-after-close race as fetch(): never register past a teardown
    if (this.#state === "closed" || this.#state === "error") throw new Error("Tunnel closed");
    const id = `w${Math.random().toString(36).slice(2)}`;
    const sock = new TunnelWebSocket((f) => this.#send(f));
    this.#sockets.set(id, sock);
    sock._attach(id);
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // take it out of the map: a timed-out open must not sit in #sockets
        // forever (the app would keep a zombie reference; and anything that
        // counts open sockets would count a dead one)
        this.#sockets.delete(id);
        sock._closed();
        reject(new Error("tunnel ws open timeout"));
      }, 15_000);
      sock.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      sock.addEventListener("error", (e: unknown) => {
        clearTimeout(timer);
        this.#sockets.delete(id);
        reject(new Error(String(e)));
      });
    });
    this.#send({ t: "wopen", id, path });
    await opened;
    return sock;
  }
}
