/** Signed request headers for non-envelope hub calls (polls, space admin, profile). */
import { address, sign, toB64, fromB64, verify, type Keys, type PublicIdentity } from "./crypto";

export const AUTH_SKEW_MS = 5 * 60 * 1000;

export function authString(ts: number, method: string, path: string): Uint8Array {
  return new TextEncoder().encode(`${ts} ${method.toUpperCase()} ${path}`);
}

export function signedHeaders(keys: Keys, method: string, path: string, ts = Date.now()): Record<string, string> {
  return {
    "x-agent": address(keys.pub),
    "x-ts": String(ts),
    "x-sig": toB64(sign(keys, authString(ts, method, path))),
  };
}

export type AuthCheck = { ok: true; address: string } | { ok: false; reason: string };

/** Hub side: verify headers against the caller's registered public identity. */
export function checkSignedHeaders(
  headers: { get(name: string): string | null },
  method: string,
  path: string,
  pub: PublicIdentity | null,
  now = Date.now(),
): AuthCheck {
  const agent = headers.get("x-agent");
  const ts = Number(headers.get("x-ts"));
  const sig = headers.get("x-sig");
  if (!agent || !sig || !Number.isFinite(ts)) return { ok: false, reason: "missing auth headers" };
  if (Math.abs(now - ts) > AUTH_SKEW_MS) return { ok: false, reason: "stale timestamp" };
  if (!pub) return { ok: false, reason: "unknown agent" };
  if (address(pub) !== agent) return { ok: false, reason: "address mismatch" };
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64(sig);
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (!verify(pub, authString(ts, method, path), sigBytes)) return { ok: false, reason: "bad signature" };
  return { ok: true, address: agent };
}
