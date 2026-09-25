import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, build, generate, signedHeaders, type Envelope, type Keys } from "agentbus-sdk";
import { register } from "./agents.test";

const HUB = "http://hub.test";

async function send(env: Envelope) {
  return SELF.fetch(`${HUB}/v1/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
}

async function poll(keys: Keys, since = 0, limit = 50) {
  const path = `/v1/inbox`;
  const res = await SELF.fetch(`${HUB}${path}?since=${since}&limit=${limit}`, { headers: signedHeaders(keys, "GET", path) });
  return { res, body: (await res.json()) as { messages: { seq: number; envelope: Envelope }[]; next: number } };
}

describe("send and inbox", () => {
  it("delivers a DM that the recipient can poll, with seq 1 and a cursor", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const env = build(a, { to: address(b.pub), kind: "dm", body: { plain: { text: "hi" } } });
    const res = await send(env);
    expect(res.status).toBe(202);
    const { id, seq } = (await res.json()) as { id: string; seq: number };
    expect(id).toBe(env.id);
    expect(seq).toBe(1);
    const { body } = await poll(b);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].seq).toBe(1);
    expect(body.messages[0].envelope.body).toEqual({ plain: { text: "hi" } });
    expect(body.next).toBe(1);
    const after = await poll(b, 1);
    expect(after.body.messages).toHaveLength(0);
  });

  it("stores a replayed envelope once and answers 202 both times with the same seq", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const env = build(a, { to: address(b.pub), kind: "dm", body: { plain: 1 } });
    const r1 = (await (await send(env)).json()) as { seq: number };
    const r2res = await send(env);
    expect(r2res.status).toBe(202);
    const r2 = (await r2res.json()) as { seq: number };
    expect(r2.seq).toBe(r1.seq);
    const { body } = await poll(b);
    expect(body.messages).toHaveLength(1);
  });

  it("rejects an envelope whose from does not match the signing key", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const env = build(a, { to: address(b.pub), kind: "dm", body: { plain: 1 } });
    const forged: Envelope = { ...env, from: address(b.pub) };
    expect((await send(forged)).status).toBe(401);
    const tampered: Envelope = { ...env, body: { plain: 2 } };
    expect((await send(tampered)).status).toBe(401);
  });

  it("rejects unknown senders and unknown recipients", async () => {
    const stranger = generate();
    const { keys: b } = await register();
    const env = build(stranger, { to: address(b.pub), kind: "dm", body: { plain: 1 } });
    expect((await send(env)).status).toBe(401);
    const { keys: a } = await register();
    const nobody = build(a, { to: "ab:" + "f".repeat(32), kind: "dm", body: { plain: 1 } });
    expect((await send(nobody)).status).toBe(404);
  });

  it("rejects envelopes over 64 KB", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const env = build(a, { to: address(b.pub), kind: "dm", body: { plain: "x".repeat(66000) } });
    expect((await send(env)).status).toBe(413);
  });

  it("requires a signed poll", async () => {
    const res = await SELF.fetch(`${HUB}/v1/inbox`);
    expect(res.status).toBe(401);
  });
});
