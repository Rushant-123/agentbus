import { describe, expect, it } from "vitest";
import vectors from "./vectors.json";
import {
  address,
  decodeKeys,
  encodeKeys,
  fingerprint,
  generate,
  groupDecrypt,
  groupEncrypt,
  groupKey,
  keysFromSeeds,
  openSealed,
  pubFromJson,
  pubToJson,
  seal,
  sign,
  verify,
} from "../src/crypto";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (u: Uint8Array) => new TextDecoder().decode(u);

describe("crypto: byte compatibility with toragents vectors", () => {
  const pub = pubFromJson({ verify_key: vectors.verify_key, box_key: vectors.box_key });
  const keys = keysFromSeeds(b64(vectors.private_raw._signing), b64(vectors.private_raw._box));

  it("derives the same fingerprint and address", () => {
    expect(fingerprint(pub)).toBe(vectors.fingerprint);
    expect(address(pub)).toBe("ab:" + vectors.fingerprint);
    expect(address(keys.pub)).toBe("ab:" + vectors.fingerprint);
  });

  it("opens a sealed box made by PyNaCl", () => {
    expect(text(openSealed(keys, b64(vectors.sealed_hello)))).toBe("hello");
  });

  it("decrypts a group message made by PyNaCl", () => {
    expect(text(groupDecrypt(b64(vectors.group_key), b64(vectors.group_ct_team)))).toBe("team");
  });

  it("verifies a PyNaCl signature", () => {
    expect(verify(pub, utf8(vectors.msg), b64(vectors.sig_of_envelope_bytes))).toBe(true);
    const bad = b64(vectors.sig_of_envelope_bytes);
    bad[3] ^= 1;
    expect(verify(pub, utf8(vectors.msg), bad)).toBe(false);
  });
});

describe("crypto: round trips", () => {
  it("sign then verify, and rejects other keys", () => {
    const a = generate();
    const b = generate();
    const sig = sign(a, utf8("m"));
    expect(verify(a.pub, utf8("m"), sig)).toBe(true);
    expect(verify(b.pub, utf8("m"), sig)).toBe(false);
  });

  it("seal to a recipient, only they can open", () => {
    const a = generate();
    const b = generate();
    const sealed = seal(b.pub, utf8("secret"));
    expect(text(openSealed(b, sealed))).toBe("secret");
    expect(() => openSealed(a, sealed)).toThrow();
  });

  it("group encrypt uses a fresh nonce and decrypts", () => {
    const k = groupKey();
    const c1 = groupEncrypt(k, utf8("x"));
    const c2 = groupEncrypt(k, utf8("x"));
    expect(c1).not.toEqual(c2);
    expect(text(groupDecrypt(k, c1))).toBe("x");
    expect(() => groupDecrypt(groupKey(), c1)).toThrow();
  });

  it("encodes and decodes keys losslessly", () => {
    const a = generate();
    const back = decodeKeys(encodeKeys(a));
    expect(address(back.pub)).toBe(address(a.pub));
    expect(text(openSealed(back, seal(a.pub, utf8("z"))))).toBe("z");
    expect(pubFromJson(pubToJson(a.pub)).verifyKey).toEqual(a.pub.verifyKey);
  });
});
