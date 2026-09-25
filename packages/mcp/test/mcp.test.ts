import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { address, generate, makeInvite, newSpaceKey, type Envelope } from "agentbus-sdk";
import { createServer } from "../src/server";

describe("agentbus MCP server", () => {
  it("exposes the tools and round-trips whoami, send, inbox (with invite auto-join), post, context, queue, directory", async () => {
    const env = { AGENTBUS_HOME: mkdtempSync(join(tmpdir(), "abmcp-")), AGENTBUS_HUB: "https://hub.test" };
    const other = generate();
    const key = newSpaceKey("01ARZ3NDEKTSV4RRFFQ69G5FAV", "team");
    let myAddress = "";
    const posts: Envelope[] = [];
    const items: { id: string; payload: unknown; state: string }[] = [];
    const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/agents") {
        const b = JSON.parse(String(init.body));
        myAddress = "ab:" + "a".repeat(32);
        return Response.json({ address: myAddress, verify_key: b.verify_key }, { status: 201 });
      }
      if (url.pathname.startsWith("/v1/agents/")) return Response.json({ address: address(other.pub), verify_key: btoa(String.fromCharCode(...other.pub.verifyKey)), box_key: btoa(String.fromCharCode(...other.pub.boxKey)) });
      if (url.pathname === "/v1/send") { const e = JSON.parse(String(init.body)); return Response.json({ id: e.id, seq: 9 }, { status: 202 }); }
      if (url.pathname === "/v1/inbox") {
        // an invite from `other` sealed to the server's own keys: read the key file the server wrote
        const { decodeKeys } = await import("agentbus-sdk");
        const { readFileSync } = await import("node:fs");
        const mine = decodeKeys(readFileSync(join(env.AGENTBUS_HOME, "key.json"), "utf8"));
        const inv = makeInvite(other, address(mine.pub), mine.pub, key);
        return Response.json({ messages: [{ seq: 1, envelope: inv }], next: 1 });
      }
      if (url.pathname.endsWith("/board") && init.method === "POST") { const e = JSON.parse(String(init.body)); posts.push(e); return Response.json({ id: e.id, seq: posts.length }, { status: 202 }); }
      if (url.pathname.endsWith("/board")) { const since = Number(url.searchParams.get("since") ?? 0); const page = posts.map((e, i) => ({ seq: i + 1, author: e.from, epoch: 1, envelope: e })).filter((p) => p.seq > since); return Response.json({ posts: page, next: page.length ? page[page.length - 1].seq : since }); }
      if (url.pathname.endsWith("/queue") && init.method === "POST") { const b = JSON.parse(String(init.body)); items.push({ id: "it1", payload: b.payload, state: "ready" }); return Response.json({ id: "it1" }, { status: 201 }); }
      if (url.pathname.endsWith("/queue/lease")) { const it = items.find((i) => i.state === "ready"); if (!it) return new Response(null, { status: 204 }); it.state = "leased"; return Response.json({ item: { id: it.id, payload: it.payload, attempts: 1, lease_until: 0, created: 0 } }); }
      if (url.pathname.endsWith("/ack")) { items[0].state = "done"; return Response.json({ ok: true }); }
      if (url.pathname === "/v1/directory") return Response.json({ entries: [{ address: address(other.pub), profile: { name: "other", kind: "agent", capabilities: [], listed: true } }] });
      return Response.json({ error: "unexpected " + url.pathname }, { status: 500 });
    };

    const server = createServer({ env, fetch: fetchImpl });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["directory_search", "post_to_space", "queue_done", "queue_push", "queue_take", "read_inbox", "send_message", "space_context", "whoami"]);

    const who = await client.callTool({ name: "whoami", arguments: {} });
    expect(existsSync(join(env.AGENTBUS_HOME, "key.json"))).toBe(true);
    const { decodeKeys: dk } = await import("agentbus-sdk");
    const { readFileSync: rf } = await import("node:fs");
    expect(JSON.parse((who.content as any)[0].text).address).toBe(address(dk(rf(join(env.AGENTBUS_HOME, "key.json"), "utf8")).pub));
    expect(myAddress).toMatch(/^ab:/);

    const sent = await client.callTool({ name: "send_message", arguments: { to: address(other.pub), text: "hi", sealed: true } });
    expect((sent.content as any)[0].text).toMatch(/^sent /);

    const inbox = await client.callTool({ name: "read_inbox", arguments: {} });
    const parsed = JSON.parse((inbox.content as any)[0].text);
    expect(parsed.messages[0]).toMatchObject({ kind: "invite", joined: "team" });
    expect(existsSync(join(env.AGENTBUS_HOME, "spaces", key.space_id + ".json"))).toBe(true);

    await client.callTool({ name: "post_to_space", arguments: { space: "team", text: "standup at 9" } });
    expect(JSON.stringify(posts[0].body)).not.toContain("standup");
    const ctx = await client.callTool({ name: "space_context", arguments: { space: "team" } });
    expect((ctx.content as any)[0].text).toContain("standup at 9");

    await client.callTool({ name: "queue_push", arguments: { space: "team", payload: { job: 1 } } });
    const took = await client.callTool({ name: "queue_take", arguments: { space: "team" } });
    expect(JSON.parse((took.content as any)[0].text).id).toBe("it1");
    await client.callTool({ name: "queue_done", arguments: { space: "team", item_id: "it1", success: true } });
    expect(items[0].state).toBe("done");

    const dir = await client.callTool({ name: "directory_search", arguments: { q: "other" } });
    expect(JSON.parse((dir.content as any)[0].text)[0].profile.name).toBe("other");
  });
});
