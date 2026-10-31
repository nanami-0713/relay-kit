// E2ESession — the 3-step PAKE-style handshake + encrypted frame exchange.
// Ported from Alma's Ng class (bundled main.js:11777-11851).
// Transport-agnostic: `send` gets JSON strings (handshake) or raw ciphertext
// bytes (post-handshake); onMessage accepts either. Serialization is internal
// so out-of-order arrivals can't interleave crypto ops.

import { b64uDecode, b64uEncode, deriveSessionKeys, generateEphemeral, GcmStream, timingSafeEqual } from "./crypto.ts";

export type E2ERole = "initiator" | "responder";

export interface E2ESessionOpts {
  role: E2ERole;
  code: string;
  send: (data: string | Uint8Array) => void;
  onReady: () => void;
  onFrame: (frame: unknown) => void;
  onError: (message: string) => void;
}

export class E2ESession {
  #role: E2ERole;
  #code: string;
  #send: (data: string | Uint8Array) => void;
  #onReady: () => void;
  #onFrame: (frame: unknown) => void;
  #onError: (message: string) => void;
  #eph: Awaited<ReturnType<typeof generateEphemeral>> | null = null;
  #myNonce = crypto.getRandomValues(new Uint8Array(16));
  #keys: Awaited<ReturnType<typeof deriveSessionKeys>> | null = null;
  #sendStream: GcmStream | null = null;
  #recvStream: GcmStream | null = null;
  #state: "init" | "await-hi" | "await-ok" | "ready" | "failed" = "init";
  #outbox: unknown[] = [];
  #outgoing: Promise<void> = Promise.resolve();
  #incoming: Promise<void> = Promise.resolve();
  #enc = new TextEncoder();
  #dec = new TextDecoder();

  constructor(opts: E2ESessionOpts) {
    this.#role = opts.role;
    this.#code = opts.code;
    this.#send = opts.send;
    this.#onReady = opts.onReady;
    this.#onFrame = opts.onFrame;
    this.#onError = opts.onError;
  }

  async start() {
    if (this.#role !== "initiator") return;
    this.#eph = await generateEphemeral();
    this.#state = "await-hi";
    this.#send(JSON.stringify({ t: "hi", epk: b64uEncode(this.#eph.publicKeyRaw), n: b64uEncode(this.#myNonce) }));
  }

  isReady(): boolean {
    return this.#state === "ready";
  }

  /** Queue a frame; flushes once the handshake completes. Order is preserved. */
  sendFrame(frame: unknown): Promise<void> {
    if (this.#state === "failed") return Promise.resolve();
    if (this.#state !== "ready" || !this.#sendStream) {
      this.#outbox.push(frame);
      return Promise.resolve();
    }
    const p = this.#outgoing.then(async () => {
      if (this.#state === "failed" || !this.#sendStream) throw new Error("E2E session failed");
      const wire = await this.#sendStream.seal(this.#enc.encode(JSON.stringify(frame)));
      this.#send(wire);
    });
    this.#outgoing = p.catch((e) => this.#fail(e instanceof Error ? e.message : String(e)));
    return p;
  }

  /** Feed one transport message (string = handshake JSON, bytes = ciphertext). */
  onMessage(data: string | Uint8Array): Promise<void> {
    this.#incoming = this.#incoming.then(() => this.#consume(data)).catch(() => {});
    return this.#incoming;
  }

  async #consume(data: string | Uint8Array) {
    if (this.#state === "failed") return;
    try {
      if (typeof data === "string") {
        await this.#onHandshake(JSON.parse(data));
      } else {
        if (!this.#recvStream) return;
        const plain = await this.#recvStream.open(data);
        this.#onFrame(JSON.parse(this.#dec.decode(plain)));
      }
    } catch (e) {
      this.#fail(e instanceof Error ? e.message : String(e));
    }
  }

  async #onHandshake(msg: any) {
    // Responder receives hi -> derive keys, reply with hi + confirmResponder.
    if (this.#role === "responder" && msg.t === "hi" && this.#state === "init") {
      const peerPub = b64uDecode(String(msg.epk));
      const peerNonce = b64uDecode(String(msg.n));
      this.#eph = await generateEphemeral();
      this.#keys = await deriveSessionKeys({
        privateKey: this.#eph.privateKey,
        peerPublicKeyRaw: peerPub,
        code: this.#code,
        initiatorPublicKeyRaw: peerPub,
        responderPublicKeyRaw: this.#eph.publicKeyRaw,
        initiatorNonce: peerNonce,
        responderNonce: this.#myNonce,
      });
      this.#state = "await-ok";
      this.#send(
        JSON.stringify({
          t: "hi",
          epk: b64uEncode(this.#eph.publicKeyRaw),
          n: b64uEncode(this.#myNonce),
          cr: b64uEncode(this.#keys.confirmResponder),
        }),
      );
      return;
    }
    // Initiator receives hi -> verify confirmResponder, send confirmInitiator.
    if (this.#role === "initiator" && msg.t === "hi" && this.#state === "await-hi") {
      const peerPub = b64uDecode(String(msg.epk));
      const peerNonce = b64uDecode(String(msg.n));
      this.#keys = await deriveSessionKeys({
        privateKey: this.#eph!.privateKey,
        peerPublicKeyRaw: peerPub,
        code: this.#code,
        initiatorPublicKeyRaw: this.#eph!.publicKeyRaw,
        responderPublicKeyRaw: peerPub,
        initiatorNonce: this.#myNonce,
        responderNonce: peerNonce,
      });
      if (!timingSafeEqual(b64uDecode(String(msg.cr)), this.#keys.confirmResponder)) {
        this.#send(JSON.stringify({ t: "err", message: "auth-failed" }));
        this.#fail("Handshake authentication failed (wrong code or man-in-the-middle)");
        return;
      }
      this.#send(JSON.stringify({ t: "ok", ci: b64uEncode(this.#keys.confirmInitiator) }));
      this.#sendStream = new GcmStream(this.#keys.c2s);
      this.#recvStream = new GcmStream(this.#keys.s2c);
      await this.#markReady();
      return;
    }
    // Responder receives ok -> verify confirmInitiator.
    if (this.#role === "responder" && msg.t === "ok" && this.#state === "await-ok") {
      if (!timingSafeEqual(b64uDecode(String(msg.ci)), this.#keys!.confirmInitiator)) {
        this.#fail("Handshake authentication failed (wrong code or man-in-the-middle)");
        return;
      }
      this.#sendStream = new GcmStream(this.#keys!.s2c);
      this.#recvStream = new GcmStream(this.#keys!.c2s);
      await this.#markReady();
      return;
    }
    if (msg.t === "err") this.#fail(`Peer rejected handshake: ${String(msg.message || "unknown")}`);
  }

  async #markReady() {
    this.#state = "ready";
    this.#onReady();
    const pending = this.#outbox;
    this.#outbox = [];
    for (const f of pending) await this.sendFrame(f);
  }

  #fail(message: string) {
    if (this.#state !== "failed") {
      this.#state = "failed";
      this.#onError(message);
    }
  }
}
