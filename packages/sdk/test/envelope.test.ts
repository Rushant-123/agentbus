import { describe, expect, it } from "vitest";
import { generate, address } from "../src/crypto";
import { build, canonical, sizeOk, verifyEnvelope, type Envelope } from "../src/envelope";

describe("canonical", () => {
  it("sorts keys recursively with no whitespace", () => {
    expect(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("drops undefined values and keeps null", () => {
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("build + verifyEnvelope", () => {
  const a = generate();
  const b = generate();

  it("fills v, id, ts, from and signs", () => {
    const env = build(a, { to: address(b.pub), kind: "dm", priority: "normal", body: { plain: { text: "hi" } } });
    expect(env.v).toBe(1);
    expect(env.from).toBe(address(a.pub));
    expect(env.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof env.ts).toBe("number");
    expect(verifyEnvelope(env, a.pub)).toBe(true);
  });

  it("fails when any field is tampered", () => {
    const env = build(a, { to: address(b.pub), kind: "dm", priority: "normal", body: { plain: 1 } });
    const t1: Envelope = { ...env, to: address(a.pub) };
    expect(verifyEnvelope(t1, a.pub)).toBe(false);
    const t2: Envelope = { ...env, body: { plain: 2 } };
    expect(verifyEnvelope(t2, a.pub)).toBe(false);
  });

  it("fails against the wrong public key, and when from does not match the key", () => {
    const env = build(a, { to: address(b.pub), kind: "dm", priority: "normal", body: { plain: 1 } });
    expect(verifyEnvelope(env, b.pub)).toBe(false);
    const forged: Envelope = { ...env, from: address(b.pub) };
    expect(verifyEnvelope(forged, a.pub)).toBe(false);
  });

  it("ids are unique and time-ordered", () => {
    const e1 = build(a, { to: "ab:" + "0".repeat(32), kind: "dm", priority: "low", body: { plain: 1 }, ts: 1000 });
    const e2 = build(a, { to: "ab:" + "0".repeat(32), kind: "dm", priority: "low", body: { plain: 1 }, ts: 2000 });
    expect(e1.id).not.toBe(e2.id);
    expect(e1.id < e2.id).toBe(true);
  });

  it("sizeOk caps at 64 KB of canonical envelope", () => {
    const small = build(a, { to: address(b.pub), kind: "dm", priority: "normal", body: { plain: "x".repeat(1000) } });
    expect(sizeOk(small)).toBe(true);
    const big = build(a, { to: address(b.pub), kind: "dm", priority: "normal", body: { plain: "x".repeat(66000) } });
    expect(sizeOk(big)).toBe(false);
  });
});
