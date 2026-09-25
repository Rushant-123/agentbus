import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, buildPost, decryptFromSpace, newSpaceKey, signedHeaders, type Envelope, type Keys } from "agentbus-sdk";
import { register } from "./agents.test";

const HUB = "http://hub.test";

async function signedJson(keys: Keys, method: string, path: string, body?: unknown) {
  const pathname = path.split("?")[0];
  const res = await SELF.fetch(`${HUB}${path}`, { method, headers: { ...signedHeaders(keys, method, pathname), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

async function postEnvelope(path: string, env: Envelope) {
  const res = await SELF.fetch(`${HUB}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
  return { status: res.status, body: (await res.json()) as any };
}

async function team() {
  const { keys: owner } = await register();
  const { keys: m1 } = await register();
  const { keys: m2 } = await register();
  const { keys: outsider } = await register();
  const created = await signedJson(owner, "POST", "/v1/spaces", { name: "t" });
  const id = created.body.id as string;
  await signedJson(owner, "POST", `/v1/spaces/${id}/members`, { address: address(m1.pub) });
  await signedJson(owner, "POST", `/v1/spaces/${id}/members`, { address: address(m2.pub) });
  return { owner, m1, m2, outsider, id, key: newSpaceKey(id, "t") };
}

describe("topic", () => {
  it("publish fans out to every other member's inbox, encrypted, except muted members and non-members", async () => {
    const { owner, m1, m2, outsider, id, key } = await team();
    expect((await signedJson(m2, "PUT", `/v1/spaces/${id}/topic/subscription`, { enabled: false })).status).toBe(200);
    const pub = buildPost(owner, key, { text: "deploy done" }, "topic");
    const r = await postEnvelope(`/v1/spaces/${id}/topic`, pub);
    expect(r.status).toBe(202);
    expect(r.body.delivered).toBe(1);
    const m1Inbox = await signedJson(m1, "GET", "/v1/inbox?since=0");
    expect(m1Inbox.body.messages).toHaveLength(1);
    expect(m1Inbox.body.messages[0].envelope.kind).toBe("topic");
    expect(decryptFromSpace(key, m1Inbox.body.messages[0].envelope.body)).toEqual({ text: "deploy done" });
    expect((await signedJson(m2, "GET", "/v1/inbox?since=0")).body.messages).toHaveLength(0);
    expect((await signedJson(owner, "GET", "/v1/inbox?since=0")).body.messages).toHaveLength(0);
    expect((await postEnvelope(`/v1/spaces/${id}/topic`, buildPost(outsider, key, 1, "topic"))).status).toBe(403);
    // unmute and publish again: m2 now receives
    await signedJson(m2, "PUT", `/v1/spaces/${id}/topic/subscription`, { enabled: true });
    const r2 = await postEnvelope(`/v1/spaces/${id}/topic`, buildPost(owner, key, 2, "topic"));
    expect(r2.body.delivered).toBe(2);
  });
});

describe("queue", () => {
  it("push, two competing leases get different items, ack completes, empty lease is 204", async () => {
    const { owner, m1, m2, outsider, id } = await team();
    expect((await signedJson(outsider, "POST", `/v1/spaces/${id}/queue`, { payload: { job: "x" } })).status).toBe(403);
    const p1 = await signedJson(owner, "POST", `/v1/spaces/${id}/queue`, { payload: { job: 1 } });
    const p2 = await signedJson(owner, "POST", `/v1/spaces/${id}/queue`, { payload: { job: 2 } });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
    const l1 = await signedJson(m1, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 30 });
    const l2 = await signedJson(m2, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 30 });
    expect(l1.status).toBe(200);
    expect(l2.status).toBe(200);
    expect(l1.body.item.id).not.toBe(l2.body.item.id);
    expect([l1.body.item.payload.job, l2.body.item.payload.job].sort()).toEqual([1, 2]);
    expect((await signedJson(m1, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 30 })).status).toBe(204);
    expect((await signedJson(m1, "POST", `/v1/spaces/${id}/queue/${l1.body.item.id}/ack`)).status).toBe(200);
    // acking someone else's lease is refused
    expect((await signedJson(m1, "POST", `/v1/spaces/${id}/queue/${l2.body.item.id}/ack`)).status).toBe(409);
    expect((await signedJson(m2, "POST", `/v1/spaces/${id}/queue/${l2.body.item.id}/ack`)).status).toBe(200);
    const stats = await signedJson(owner, "GET", `/v1/spaces/${id}/queue`);
    expect(stats.body).toMatchObject({ ready: 0, leased: 0, done: 2, dead: 0 });
  });

  it("an expired lease is re-leased to another consumer and the late ack is rejected", async () => {
    const { owner, m1, m2, id } = await team();
    await signedJson(owner, "POST", `/v1/spaces/${id}/queue`, { payload: { job: "slow" } });
    const l1 = await signedJson(m1, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 1 });
    expect(l1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1200));
    const l2 = await signedJson(m2, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 30 });
    expect(l2.status).toBe(200);
    expect(l2.body.item.id).toBe(l1.body.item.id);
    expect(l2.body.item.attempts).toBe(2);
    expect((await signedJson(m1, "POST", `/v1/spaces/${id}/queue/${l1.body.item.id}/ack`)).status).toBe(409);
    expect((await signedJson(m2, "POST", `/v1/spaces/${id}/queue/${l1.body.item.id}/ack`)).status).toBe(200);
  });

  it("five nacks move an item to the dead letter list", async () => {
    const { owner, m1, id } = await team();
    await signedJson(owner, "POST", `/v1/spaces/${id}/queue`, { payload: { job: "bad" } });
    for (let i = 0; i < 5; i++) {
      const l = await signedJson(m1, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 30 });
      expect(l.status).toBe(200);
      expect((await signedJson(m1, "POST", `/v1/spaces/${id}/queue/${l.body.item.id}/nack`)).status).toBe(200);
    }
    expect((await signedJson(m1, "POST", `/v1/spaces/${id}/queue/lease`, { timeout_s: 30 })).status).toBe(204);
    const dead = await signedJson(owner, "GET", `/v1/spaces/${id}/queue/dead`);
    expect(dead.body.items).toHaveLength(1);
    expect(dead.body.items[0].payload).toEqual({ job: "bad" });
  });
});
