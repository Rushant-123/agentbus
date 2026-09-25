import { describe, expect, it } from "vitest";
import { address, generate, openSealed, verifyEnvelope, type Envelope } from "../src";
import { HubClient, type FetchLike } from "../src/client";
import { decryptFromSpace, newSpaceKey, openInvite } from "../src/space";

type Call = { url: string; init: RequestInit };

function fakeHub(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), init });
    return handler(url, init);
  };
  return { fetch, calls };
}

describe("HubClient", () => {
  const keys = generate();
  const other = generate();

  it("registers with a self-signed body", async () => {
    const hub = fakeHub(async (url, init) => {
      expect(url.pathname).toBe("/v1/agents");
      const body = JSON.parse(String(init.body));
      expect(body.verify_key).toBeTruthy();
      expect(body.sig).toBeTruthy();
      return Response.json({ address: address(keys.pub) }, { status: 201 });
    });
    const c = new HubClient("https://hub.test", keys, hub.fetch);
    expect(await c.register()).toEqual({ address: address(keys.pub), created: true });
  });

  it("sends a plain DM as a valid envelope", async () => {
    let posted: Envelope | undefined;
    const hub = fakeHub(async (url, init) => {
      posted = JSON.parse(String(init.body));
      return Response.json({ id: posted!.id, seq: 7 }, { status: 202 });
    });
    const c = new HubClient("https://hub.test", keys, hub.fetch);
    const r = await c.send(address(other.pub), { text: "hi" });
    expect(r.seq).toBe(7);
    expect(posted!.to).toBe(address(other.pub));
    expect(posted!.kind).toBe("dm");
    expect(posted!.body).toEqual({ plain: { text: "hi" } });
    expect(verifyEnvelope(posted!, keys.pub)).toBe(true);
  });

  it("sends a sealed DM only the recipient can read, after looking up their box key", async () => {
    let posted: Envelope | undefined;
    const hub = fakeHub(async (url, init) => {
      if (url.pathname.startsWith("/v1/agents/")) {
        return Response.json({ address: address(other.pub), verify_key: btoa(String.fromCharCode(...other.pub.verifyKey)), box_key: btoa(String.fromCharCode(...other.pub.boxKey)) });
      }
      posted = JSON.parse(String(init.body));
      return Response.json({ id: posted!.id, seq: 1 }, { status: 202 });
    });
    const c = new HubClient("https://hub.test", keys, hub.fetch);
    await c.send(address(other.pub), { text: "secret" }, { sealed: true });
    expect("sealed" in posted!.body).toBe(true);
    const opened = openSealed(other, Uint8Array.from(atob((posted!.body as { sealed: string }).sealed), (ch) => ch.charCodeAt(0)));
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ text: "secret" });
  });

  it("polls with signed headers and surfaces errors with status", async () => {
    const hub = fakeHub(async (url, init) => {
      const h = init.headers as Record<string, string>;
      expect(h["x-agent"]).toBe(address(keys.pub));
      expect(h["x-sig"]).toBeTruthy();
      if (url.searchParams.get("since") === "9") return Response.json({ error: "boom" }, { status: 500 });
      return Response.json({ messages: [], next: 3 });
    });
    const c = new HubClient("https://hub.test", keys, hub.fetch);
    expect((await c.poll(3)).next).toBe(3);
    await expect(c.poll(9)).rejects.toThrow(/500/);
  });

  it("builds a signed websocket url", () => {
    const c = new HubClient("https://hub.test", keys, fakeHub(async () => new Response()).fetch);
    const u = new URL(c.wsUrl(5));
    expect(u.protocol).toBe("wss:");
    expect(u.pathname).toBe("/v1/inbox/ws");
    expect(u.searchParams.get("agent")).toBe(address(keys.pub));
    expect(u.searchParams.get("since")).toBe("5");
    expect(u.searchParams.get("sig")).toBeTruthy();
  });

  it("invite adds the member then sends a sealed invite with the returned epoch; post encrypts", async () => {
    const key = newSpaceKey("01ARZ3NDEKTSV4RRFFQ69G5FAV", "team");
    const posted: Envelope[] = [];
    const hub = fakeHub(async (url, init) => {
      if (url.pathname.startsWith("/v1/agents/")) return Response.json({ address: address(other.pub), verify_key: btoa(String.fromCharCode(...other.pub.verifyKey)), box_key: btoa(String.fromCharCode(...other.pub.boxKey)) });
      if (url.pathname.endsWith("/members")) return Response.json({ ok: true, epoch: 3 });
      if (url.pathname === "/v1/send" || url.pathname.endsWith("/board")) {
        const e = JSON.parse(String(init.body)) as Envelope;
        posted.push(e);
        return Response.json({ id: e.id, seq: posted.length }, { status: 202 });
      }
      return Response.json({ error: "unexpected " + url.pathname }, { status: 500 });
    });
    const c = new HubClient("https://hub.test", keys, hub.fetch);
    const r = await c.invite(key, address(other.pub));
    expect(r.epoch).toBe(3);
    const received = openInvite(other, posted[0]);
    expect(received.group_key).toBe(key.group_key);
    expect(received.epoch).toBe(3);
    await c.post(key, { text: "hello team" });
    expect(posted[1].to).toBe("space:" + key.space_id);
    expect(decryptFromSpace(key, posted[1].body)).toEqual({ text: "hello team" });
  });
});
