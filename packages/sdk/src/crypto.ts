/**
 * Identity and encryption primitives, byte-compatible with tor-for-agents (toragents.crypto, PyNaCl).
 * tweetnacl for Ed25519 / box / secretbox, noble blake2b for fingerprints and sealed-box nonces.
 * Measured to work inside Cloudflare Workers (docs/measurements.md); libsodium-wrappers does not.
 */
import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2.js";

export type PublicIdentity = { verifyKey: Uint8Array; boxKey: Uint8Array };
export type Keys = { signSecret: Uint8Array; boxSecret: Uint8Array; pub: PublicIdentity };

export class CryptoError extends Error {}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const toB64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
export const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toHex = (u: Uint8Array): string => Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

/** Fresh identity: Ed25519 signing pair + Curve25519 box pair. */
export function generate(): Keys {
  const s = nacl.sign.keyPair();
  const b = nacl.box.keyPair();
  return { signSecret: s.secretKey, boxSecret: b.secretKey, pub: { verifyKey: s.publicKey, boxKey: b.publicKey } };
}

/** Rebuild keys from the 32-byte seeds PyNaCl stores (SigningKey seed, PrivateKey bytes). */
export function keysFromSeeds(signSeed: Uint8Array, boxSecret: Uint8Array): Keys {
  if (signSeed.length !== 32 || boxSecret.length !== 32) throw new CryptoError("seeds must be 32 bytes");
  const s = nacl.sign.keyPair.fromSeed(signSeed);
  const b = nacl.box.keyPair.fromSecretKey(boxSecret);
  return { signSecret: s.secretKey, boxSecret: b.secretKey, pub: { verifyKey: s.publicKey, boxKey: b.publicKey } };
}

/** hex(blake2b(verify_key || box_key, 16 bytes)), identical to toragents PublicIdentity.fingerprint. */
export function fingerprint(pub: PublicIdentity): string {
  return toHex(blake2b(concat(pub.verifyKey, pub.boxKey), { dkLen: 16 }));
}

export function address(pub: PublicIdentity): string {
  return "ab:" + fingerprint(pub);
}

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^ab:[0-9a-f]{32}$/.test(s);
}

export function sign(keys: Keys, msg: Uint8Array): Uint8Array {
  return nacl.sign.detached(msg, keys.signSecret);
}

export function verify(pub: PublicIdentity, msg: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  return nacl.sign.detached.verify(msg, sig, pub.verifyKey);
}

/** libsodium crypto_box_seal: epk || box(msg, nonce = blake2b(epk || pk, 24), pk, esk). */
export function seal(to: PublicIdentity, plaintext: Uint8Array): Uint8Array {
  const e = nacl.box.keyPair();
  const nonce = blake2b(concat(e.publicKey, to.boxKey), { dkLen: 24 });
  return concat(e.publicKey, nacl.box(plaintext, nonce, to.boxKey, e.secretKey));
}

export function openSealed(keys: Keys, sealed: Uint8Array): Uint8Array {
  if (sealed.length < 32 + nacl.box.overheadLength) throw new CryptoError("sealed box too short");
  const epk = sealed.slice(0, 32);
  const nonce = blake2b(concat(epk, keys.pub.boxKey), { dkLen: 24 });
  const out = nacl.box.open(sealed.slice(32), nonce, epk, keys.boxSecret);
  if (!out) throw new CryptoError("cannot open sealed box");
  return out;
}

/** 32-byte secretbox key, same as toragents GroupKey. */
export function groupKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

/** nonce (24) || secretbox ciphertext, PyNaCl SecretBox.encrypt layout. */
export function groupEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new CryptoError("group key must be 32 bytes");
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return concat(nonce, nacl.secretbox(plaintext, nonce, key));
}

export function groupDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new CryptoError("group key must be 32 bytes");
  if (data.length < nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) throw new CryptoError("group message too short");
  const out = nacl.secretbox.open(data.slice(24), data.slice(0, 24), key);
  if (!out) throw new CryptoError("cannot decrypt group message");
  return out;
}

export function pubToJson(pub: PublicIdentity): { verify_key: string; box_key: string } {
  return { verify_key: toB64(pub.verifyKey), box_key: toB64(pub.boxKey) };
}

export function pubFromJson(j: { verify_key: string; box_key: string }): PublicIdentity {
  const verifyKey = fromB64(j.verify_key);
  const boxKey = fromB64(j.box_key);
  if (verifyKey.length !== 32 || boxKey.length !== 32) throw new CryptoError("public keys must be 32 bytes");
  return { verifyKey, boxKey };
}

/** Key file format for ~/.agentbus/key.json. Stores the two 32-byte seeds, never the expanded secret. */
export function encodeKeys(keys: Keys): string {
  return JSON.stringify({ v: 1, sign_seed: toB64(keys.signSecret.slice(0, 32)), box_secret: toB64(keys.boxSecret), ...pubToJson(keys.pub) });
}

export function decodeKeys(json: string): Keys {
  const j = JSON.parse(json) as { v: number; sign_seed: string; box_secret: string };
  if (j.v !== 1) throw new CryptoError("unknown key file version");
  return keysFromSeeds(fromB64(j.sign_seed), fromB64(j.box_secret));
}
