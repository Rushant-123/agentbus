import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, build, generate, type Envelope } from "@agentbus/sdk";
import { decide, dayKey, limits } from "../src/fee";
import { register } from "./agents.test";

const HUB = "http://hub.test";

async function send(env: Envelope) {
  const res = await SELF.fetch(`${HUB}/v1/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
  return res;
}

describe("fee decision (pure)", () => {
  it("in-space and self sends are free, strangers count up to the limit then charge", () => {
    expect(decide({ sharesSpace: true, selfSend: false, todayCount: 999, limit: 20 })).toBe("free");
    expect(decide({ sharesSpace: false, selfSend: true, todayCount: 999, limit: 20 })).toBe("free");
    expect(decide({ sharesSpace: false, selfSend: false, todayCount: 0, limit: 20 })).toBe("count");
    expect(decide({ sharesSpace: false, selfSend: false, todayCount: 19, limit: 20 })).toBe("count");
    expect(decide({ sharesSpace: false, selfSend: false, todayCount: 20, limit: 20 })).toBe("charge");
  });
  it("day key rolls at UTC midnight", () => {
    expect(dayKey(Date.UTC(2026, 8, 25, 23, 59, 59))).toBe("2026-09-25");
    expect(dayKey(Date.UTC(2026, 8, 26, 0, 0, 0))).toBe("2026-09-26");
  });
  it("limits read env with defaults", () => {
    expect(limits({})).toEqual({ strangerFreePerDay: 20, inSpacePerMin: 600, strangerPerMin: 60 });
    expect(limits({ STRANGER_FREE_PER_DAY: "3" }).strangerFreePerDay).toBe(3);
  });
});

describe("stranger fee on /v1/send (test bindings: 3 free per day, 5 in-space per minute, 4 stranger per minute)", () => {
  it("the first 3 stranger sends are free, the 4th returns 402 with an MPP challenge", async () => {
    const { keys: a } = await register();
    const targets = await Promise.all([register(), register(), register(), register()]);
    for (let i = 0; i < 3; i++) {
      const res = await send(build(a, { to: address(targets[i].keys.pub), kind: "dm", body: { plain: i } }));
      expect(res.status).toBe(202);
    }
    const res = await send(build(a, { to: address(targets[3].keys.pub), kind: "dm", body: { plain: 3 } }));
    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Payment /);
    expect(res.headers.get("www-authenticate") ?? "").toContain('method="tempo"');
    // and the message was not delivered
    const inbox = await SELF.fetch(`${HUB}/v1/inbox?since=0`, { headers: (await import("@agentbus/sdk")).signedHeaders(targets[3].keys, "GET", "/v1/inbox") });
    expect(((await inbox.json()) as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("sends inside a shared space never count against the allowance", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const { signedHeaders } = await import("@agentbus/sdk");
    const created = await SELF.fetch(`${HUB}/v1/spaces`, { method: "POST", headers: { ...signedHeaders(a, "POST", "/v1/spaces"), "content-type": "application/json" }, body: JSON.stringify({ name: "s" }) });
    const id = ((await created.json()) as { id: string }).id;
    await SELF.fetch(`${HUB}/v1/spaces/${id}/members`, { method: "POST", headers: { ...signedHeaders(a, "POST", `/v1/spaces/${id}/members`), "content-type": "application/json" }, body: JSON.stringify({ address: address(b.pub) }) });
    for (let i = 0; i < 5; i++) {
      expect((await send(build(a, { to: address(b.pub), kind: "dm", body: { plain: i } }))).status).toBe(202);
    }
    // 6th in-space send in the same minute trips the in-space rate limit (5/min in tests)
    const limited = await send(build(a, { to: address(b.pub), kind: "dm", body: { plain: 6 } }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // allowance untouched: a stranger send still goes through free
    const { keys: c } = await register();
    expect((await send(build(a, { to: address(c.pub), kind: "dm", body: { plain: "x" } }))).status).toBe(202);
  });
});
