// Tunnel frame types (§4 of PROTOCOL.md). Tag values match Alma's wire format.

export type ClientFrame =
  | { t: "hreq"; id: string; method: string; path: string; headers: Record<string, string>; b?: string }
  | { t: "hcancel"; id: string }
  | { t: "wopen"; id: string; path: string }
  | { t: "wmsg"; id: string; s?: string; b?: string }
  | { t: "wclose"; id: string; code?: number; reason?: string };

export type AgentFrame =
  | { t: "hres"; id: string; status: number; headers: Record<string, string> }
  | { t: "hchunk"; id: string; b: string }
  | { t: "hend"; id: string }
  | { t: "herr"; id: string; message: string }
  | { t: "wopened"; id: string }
  | { t: "wmsg"; id: string; s?: string; b?: string }
  | { t: "wclose"; id: string; code?: number; reason?: string }
  | { t: "werr"; id: string; message: string };

export const E2E_PATH = "/__alma_e2e__";

/** Generate a 256-bit pairing code, base64url (same width as Alma's wy()). */
export function generateCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
