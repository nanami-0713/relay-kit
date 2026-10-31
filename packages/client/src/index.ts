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

  async connect(): Promise<void> {
    if (this.#state === "connecting" || this.#state === "ready") return this.ready();
    this.#closedByUser = false;
    this.#setState("connecting");
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
        this.#startWatchdog();
        this.#setState("ready");
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
      this.#handleClose(why);
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
  }

  #rejectPending(e: Error) {
    for (const [, p] of this.#http) p.reject(e);
    this.#http.clear();
    for (const [, s] of this.#sockets) s._closed();
    this.#sockets.clear();
  }

  #handleClose(reason: string) {
    this.#stopWatchdog();
    this.#rejectPending(new Error(reason));
    for (const w of this.#readyWaiters) w.reject(new Error(reason));
    this.#readyWaiters = [];
    this.#setState(this.#closedByUser ? "closed" : "error", reason);
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
