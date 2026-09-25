import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, build, signedHeaders, type Envelope, type Keys } from "agentbus-sdk";
import { register } from "./agents.test";

const HUB = "http://hub.test";

async function openWs(keys: Keys, since = 0): Promise<WebSocket> {
  const h = signedHeaders(keys, "GET", "/v1/inbox/ws");
  const qs = new URLSearchParams({ agent: h["x-agent"], ts: h["x-ts"], sig: h["x-sig"], since: String(since) });
  const res = await SELF.fetch(`${HUB}/v1/inbox/ws?${qs}`, { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<{ seq: number; envelope: Envelope }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no message within " + timeoutMs + "ms")), timeoutMs);
    ws.addEventListener("message", (ev) => {
      clearTimeout(t);
      resolve(JSON.parse(String(ev.data)));
    }, { once: true });
  });
}

async function send(env: Envelope) {
  return SELF.fetch(`${HUB}/v1/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
}

describe("websocket push", () => {
  it("pushes a new message to a connected recipient quickly", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const ws = await openWs(b);
    const waiting = nextMessage(ws);
    const t0 = Date.now();
    const env = build(a, { to: address(b.pub), kind: "dm", body: { plain: "live" } });
    expect((await send(env)).status).toBe(202);
    const got = await waiting;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(got.seq).toBe(1);
    expect(got.envelope.id).toBe(env.id);
    ws.close();
  });

  it("replays messages missed while disconnected when reconnecting with since", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const e1 = build(a, { to: address(b.pub), kind: "dm", body: { plain: 1 } });
    const e2 = build(a, { to: address(b.pub), kind: "dm", body: { plain: 2 } });
    await send(e1);
    await send(e2);
    const ws = await openWs(b, 1);
    const got = await nextMessage(ws);
    expect(got.seq).toBe(2);
    expect(got.envelope.id).toBe(e2.id);
    ws.close();
  });

  it("rejects an unsigned or stale upgrade", async () => {
    const res = await SELF.fetch(`${HUB}/v1/inbox/ws`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });
});
