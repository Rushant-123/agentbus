/** Signed message envelopes. Everything on the bus is one of these. */
import { address, isAddress, sign, toB64, fromB64, verify, type Keys, type PublicIdentity } from "./crypto";

export type Priority = "urgent" | "normal" | "low";

export type Body =
  | { plain: unknown }
  | { sealed: string } // base64 sealed box to the recipient's box key
  | { group: string; ct: string }; // space id + base64 secretbox ciphertext

export type Envelope = {
  v: 1;
  id: string;
  from: string;
  to: string;
  kind: string;
  ts: number;
  priority: Priority;
  reply_to?: string;
  body: Body;
  sig: string;
};

export const MAX_ENVELOPE_BYTES = 65536;

/** Deterministic JSON: sorted keys at every level, no whitespace, undefined dropped. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v === undefined ? null : v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 10 chars of time (ms), 16 chars of randomness. Sortable by creation time. */
export function ulid(ts = Date.now()): string {
  let t = ts;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ULID_ALPHABET[rnd[i] % 32];
  return time + rand;
}

export type BuildFields = {
  to: string;
  kind: string;
  priority?: Priority;
  reply_to?: string;
  body: Body;
  id?: string;
  ts?: number;
};

function unsigned(env: Omit<Envelope, "sig">): Uint8Array {
  return new TextEncoder().encode(canonical(env));
}

export function build(keys: Keys, f: BuildFields): Envelope {
  const ts = f.ts ?? Date.now();
  const env: Omit<Envelope, "sig"> = {
    v: 1,
    id: f.id ?? ulid(ts),
    from: address(keys.pub),
    to: f.to,
    kind: f.kind,
    ts,
    priority: f.priority ?? "normal",
    reply_to: f.reply_to,
    body: f.body,
  };
  return { ...env, sig: toB64(sign(keys, unsigned(env))) };
}

/** True when the envelope is well-formed, `from` is the address of `pub`, and the signature holds. */
export function verifyEnvelope(env: Envelope, pub: PublicIdentity): boolean {
  if (!env || env.v !== 1 || typeof env.sig !== "string") return false;
  if (!isAddress(env.from) || typeof env.to !== "string" || typeof env.kind !== "string") return false;
  if (typeof env.ts !== "number" || typeof env.id !== "string" || !env.body || typeof env.body !== "object") return false;
  if (env.from !== address(pub)) return false;
  const { sig, ...rest } = env;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromB64(sig);
  } catch {
    return false;
  }
  return verify(pub, unsigned(rest), sigBytes);
}

export function sizeOk(env: Envelope): boolean {
  return new TextEncoder().encode(canonical(env)).length <= MAX_ENVELOPE_BYTES;
}
