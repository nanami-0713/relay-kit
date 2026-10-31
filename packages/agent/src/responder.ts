// E2EResponder — runs one E2E session as the responder and dispatches the
// decrypted inner frames (hreq/wopen/wmsg/wclose) to the local port.
// Ported from Alma's py class (bundled main.js:12187-12305).

import WebSocket from "ws";
import { E2ESession } from "@hsinsekai-nanami/core";
import type { ClientFrame } from "@hsinsekai-nanami/core";

const CHUNK_SIZE = 32_768;

export interface E2EResponderOpts {
  code: string;
  localPort: number;
  send: (data: string | Uint8Array) => void;
  onError?: (message: string) => void;
}

export class E2EResponder {
  #session: E2ESession;
  #localPort: number;
  #httpAborts = new Map<string, AbortController>();
  #localSockets = new Map<string, WebSocket>();
  #destroyed = false;
  #sendRaw: (data: string | Uint8Array) => void;

  constructor(opts: E2EResponderOpts) {
    this.#localPort = opts.localPort;
    this.#sendRaw = opts.send;
    this.#session = new E2ESession({
      role: "responder",
      code: opts.code,
      send: (data) => {
        if (!this.#destroyed) this.#sendRaw(data);
      },
      onReady: () => {},
      onFrame: (frame) => this.#onInnerFrame(frame as ClientFrame),
      onError: (message) => {
        opts.onError?.(message);
        this.destroy();
      },
    });
  }

  onMessage(data: string | Uint8Array) {
    return this.#session.onMessage(data);
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const a of this.#httpAborts.values()) a.abort();
    this.#httpAborts.clear();
    for (const s of this.#localSockets.values()) {
      try {
        s.close();
      } catch {}
    }
    this.#localSockets.clear();
  }

  #send(frame: ClientFrame | { t: string; [k: string]: unknown }) {
    if (!this.#destroyed) void this.#session.sendFrame(frame);
  }

  #onInnerFrame(frame: any) {
    switch (frame.t) {
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
      case "wopen":
        this.#proxyWsOpen(String(frame.id), String(frame.path || "/"));
        break;
      case "wmsg": {
        const id = String(frame.id);
        const ws = this.#localSockets.get(id);
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (typeof frame.s === "string") ws.send(frame.s);
        else if (typeof frame.b === "string") ws.send(Buffer.from(frame.b, "base64"));
        break;
      }
      case "wclose": {
        const id = String(frame.id);
        const ws = this.#localSockets.get(id);
        if (!ws) return;
        this.#localSockets.delete(id);
        try {
          ws.close(frame.code ?? 1000, frame.reason);
        } catch {}
        break;
      }
    }
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
      const res = await fetch(`http://127.0.0.1:${this.#localPort}${frame.path}`, {
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
            // Inside the E2E tunnel there is no direct socket backpressure signal;
            // the outbound promise chain in E2ESession serializes sends.
            this.#send({ t: "hchunk", id, b: Buffer.from(value.subarray(o, o + CHUNK_SIZE)).toString("base64") });
          }
        }
      }
      this.#send({ t: "hend", id });
    } catch (e) {
      // best-effort herr("cancelled") on hcancel aborts — see PROTOCOL.md §4
      this.#send({
        t: "herr",
        id,
        message: abort.signal.aborted ? "cancelled" : e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.#httpAborts.delete(String(id));
    }
  }

  #proxyWsOpen(id: string, path: string) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.#localPort}${path}`);
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
