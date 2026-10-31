// relay-e2e/v1 crypto layer — ported 1:1 from Alma's bundled implementation
// (bundled main.js:11717-11775, identifiers pg/fg/mg/gg/Tg/_g/Sg/Ag/$g/kg/bg/vg/Eg).
// WebCrypto only: works identically in Node >=18 and browsers.

export const PROTOCOL = "relay-e2e/v1";
const HASH = "SHA-256";
const CURVE = "P-256";
const AEAD = "AES-GCM";

const subtle = (globalThis.crypto ?? (globalThis as any).crypto).subtle;
const te = new TextEncoder();

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// WebCrypto helpers for Node too (Buffer works as ArrayBufferView via .buffer slice below).
function ab(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export async function sha256(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest(HASH, ab(input)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await sha256(te.encode(s));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic routing token derived from the pairing code.
 * The relay routes by this (and by sha256 of it) but never learns the code.
 * Kept 128-bit — same width as Alma's, short enough for a URL path segment.
 */
export async function deriveRoutingToken(code: string): Promise<string> {
  const key = await subtle.importKey("raw", ab(te.encode(code)), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: HASH, salt: te.encode(`${PROTOCOL}/routing`), info: new Uint8Array(0) },
    key,
    128,
  );
  return b64uEncode(new Uint8Array(bits));
}

export interface EphemeralPair {
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
}

export async function generateEphemeral(): Promise<EphemeralPair> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKeyRaw: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
}

async function hkdfWithLabel(shared: Uint8Array, salt: Uint8Array, label: string, transcript: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", ab(shared), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await subtle.deriveBits({ name: "HKDF", hash: HASH, salt: ab(salt), info: ab(concatBytes(te.encode(label), transcript)) }, key, 256),
  );
}

export interface HandshakeParams {
  privateKey: CryptoKey;
  peerPublicKeyRaw: Uint8Array;
  code: string;
  initiatorPublicKeyRaw: Uint8Array;
  responderPublicKeyRaw: Uint8Array;
  initiatorNonce: Uint8Array;
  responderNonce: Uint8Array;
}

export interface SessionKeys {
  c2s: CryptoKey;
  s2c: CryptoKey;
  confirmResponder: Uint8Array;
  confirmInitiator: Uint8Array;
}

/**
 * Symmetric key schedule. The transcript (both pubkeys + both nonces + protocol
 * string) is bound into every derived key, and the code is the HKDF salt —
 * an attacker without the code (including the relay) cannot produce confirms.
 */
export async function deriveSessionKeys(p: HandshakeParams): Promise<SessionKeys> {
  const peer = await subtle.importKey("raw", ab(p.peerPublicKeyRaw), { name: "ECDH", namedCurve: CURVE }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, p.privateKey, 256));
  const transcript = await sha256(concatBytes(te.encode(PROTOCOL), p.initiatorPublicKeyRaw, p.responderPublicKeyRaw, p.initiatorNonce, p.responderNonce));
  const salt = te.encode(p.code);
  const [c2s, s2c, confirmR, confirmI] = await Promise.all([
    hkdfWithLabel(shared, salt, "c2s|", transcript),
    hkdfWithLabel(shared, salt, "s2c|", transcript),
    hkdfWithLabel(shared, salt, "confirm-r|", transcript),
    hkdfWithLabel(shared, salt, "confirm-i|", transcript),
  ]);
  return {
    c2s: await subtle.importKey("raw", ab(c2s), AEAD, false, ["encrypt", "decrypt"]),
    s2c: await subtle.importKey("raw", ab(s2c), AEAD, false, ["encrypt", "decrypt"]),
    confirmResponder: confirmR,
    confirmInitiator: confirmI,
  };
}

/**
 * Directional AES-GCM stream. IV = 4 zero bytes + strictly increasing uint64 BE
 * counter. The sender's strict increment guarantees nonce uniqueness; the
 * receiver rejects any counter <= the highest seen so far, which is what
 * actually stops replays (WebSocket delivery is ordered, so a legitimate
 * peer can never trigger it — only a duplicating middlebox can).
 */
export class GcmStream {
  #counter = 0n;
  #lastReceived: bigint | null = null;
  #key: CryptoKey;
  constructor(key: CryptoKey) {
    this.#key = key;
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.#counter++);
    const ct = new Uint8Array(await subtle.encrypt({ name: AEAD, iv: ab(iv) }, this.#key, ab(plaintext)));
    return concatBytes(iv, ct);
  }

  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < 12) throw new Error("E2E frame too short");
    const iv = frame.subarray(0, 12);
    const ct = frame.subarray(12);
    const counter = new DataView(iv.buffer, iv.byteOffset + 4, 8).getBigUint64(0);
    if (this.#lastReceived !== null && counter <= this.#lastReceived) {
      throw new Error(`E2E replay detected (counter ${counter} <= ${this.#lastReceived})`);
    }
    this.#lastReceived = counter;
    return new Uint8Array(await subtle.decrypt({ name: AEAD, iv: ab(iv) }, this.#key, ab(ct)));
  }
}
