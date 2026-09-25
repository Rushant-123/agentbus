import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { describe, expect, it } from "vitest";
import { address, build, decodeKeys, generate, seal, toB64, verifyEnvelope, type Envelope } from "@agentbus/sdk";
import { context, join, listen, post, read, send, spacesCreate, spacesInvite, spacesList, whoami, type Io } from "../src/commands";
import { parse } from "../src/index";

function fakeIo(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, wsFrames: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const execs: { cmd: string; input: string; env: Record<string, string> }[] = [];
  class FakeWs {
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      setTimeout(() => {
        this.onopen?.({});
        for (const f of wsFrames) this.onmessage?.({ data: f });
        setTimeout(() => this.onclose?.({}), 5);
      }, 0);
    }
    close() {
      setTimeout(() => this.onclose?.({}), 0);
    }
  }
  const io: Io = {
    env: { AGENTBUS_HOME: mkdtempSync(pjoin(tmpdir(), "ab-")), AGENTBUS_HUB: "https://hub.test" },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: async (input, init = {}) => handler(new URL(String(input)), init),
    WebSocket: FakeWs as unknown as typeof WebSocket,
    exec: async (cmd, input, env) => {
      execs.push({ cmd, input, env });
      return 0;
    },
  };
  return { io, out, err, execs };
}

describe("cli", () => {
  it("parse splits command, args and flags", () => {
    expect(parse(["send", "ab:x", "hello", "world", "--sealed", "--kind", "task"])).toEqual({ cmd: "send", args: ["ab:x", "hello", "world"], flags: { sealed: true, kind: "task" } });
    expect(parse([]).cmd).toBe("help");
  });

  it("join creates a key file, registers, and prints the address; second join reuses the key", async () => {
    let registered = 0;
    const { io, out } = fakeIo(async (url, init) => {
      expect(url.pathname).toBe("/v1/agents");
      registered++;
      const b = JSON.parse(String(init.body));
      return Response.json({ address: "ab:" + "1".repeat(32) }, { status: registered === 1 ? 201 : 200 });
    });
    const a1 = await join(io);
    const keyPath = pjoin(io.env.AGENTBUS_HOME!, "key.json");
    expect(existsSync(keyPath)).toBe(true);
    const keys = decodeKeys(readFileSync(keyPath, "utf8"));
    const a2 = await join(io);
    expect(a1).toBe(a2);
    expect(out.some((l) => l.startsWith("created identity"))).toBe(true);
    expect(out.some((l) => l.startsWith("loaded identity"))).toBe(true);
    expect(await whoami(io)).toBe(address(keys.pub));
  });

  it("send posts a valid envelope, sealed when asked", async () => {
    const recipient = generate();
    const posted: Envelope[] = [];
    const { io } = fakeIo(async (url, init) => {
      if (url.pathname === "/v1/agents") return Response.json({ address: "x" }, { status: 201 });
      if (url.pathname.startsWith("/v1/agents/")) {
        return Response.json({ address: address(recipient.pub), verify_key: toB64(recipient.pub.verifyKey), box_key: toB64(recipient.pub.boxKey) });
      }
      const e = JSON.parse(String(init.body)) as Envelope;
      posted.push(e);
      return Response.json({ id: e.id, seq: posted.length }, { status: 202 });
    });
    await join(io);
    const keys = decodeKeys(readFileSync(pjoin(io.env.AGENTBUS_HOME!, "key.json"), "utf8"));
    await send(io, address(recipient.pub), "hello there", { urgent: true });
    await send(io, address(recipient.pub), "psst", { sealed: true });
    expect(posted).toHaveLength(2);
    expect(verifyEnvelope(posted[0], keys.pub)).toBe(true);
    expect(posted[0].priority).toBe("urgent");
    expect(posted[0].body).toEqual({ plain: { text: "hello there" } });
    expect("sealed" in posted[1].body).toBe(true);
  });

  it("listen prints plain messages, opens sealed ones, pipes to --exec, and advances the cursor", async () => {
    const sender = generate();
    const { io, out, execs } = fakeIo(async () => Response.json({ address: "x" }, { status: 201 }));
    await join(io);
    const me = decodeKeys(readFileSync(pjoin(io.env.AGENTBUS_HOME!, "key.json"), "utf8"));
    const plain = build(sender, { to: address(me.pub), kind: "dm", body: { plain: { text: "one" } } });
    const sealedBody = { sealed: toB64(seal(me.pub, new TextEncoder().encode(JSON.stringify({ text: "two" })))) };
    const sealed = build(sender, { to: address(me.pub), kind: "dm", body: sealedBody });
    const frames = [JSON.stringify({ seq: 1, envelope: plain }), JSON.stringify({ seq: 2, envelope: sealed })];
    const { io: io2, out: out2 } = fakeIo(async () => new Response(), frames);
    io2.env = io.env;
    const n = await listen(io2, {});
    expect(n).toBe(2);
    expect(out2[0]).toContain("one");
    expect(out2[1]).toContain("two");
    expect(readFileSync(pjoin(io.env.AGENTBUS_HOME!, "cursor"), "utf8")).toBe("2");

    const { io: io3, execs: execs3 } = fakeIo(async () => new Response(), frames);
    io3.env = io.env;
    await listen(io3, { exec: "cat", since: 0 });
    expect(execs3).toHaveLength(2);
    expect(execs3[0].cmd).toBe("cat");
    expect(JSON.parse(execs3[0].input).body).toEqual({ text: "one" });
    expect(execs3[1].env.AGENTBUS_FROM).toBe(address(sender.pub));
    expect(out.length + execs.length).toBeGreaterThanOrEqual(0);
  });
});

describe("cli spaces", () => {
  it("create stores a key; invite delivers it sealed; a listener auto-joins; post and context round trip through a fake hub", async () => {
    const posts: Envelope[] = [];
    const sent: Envelope[] = [];
    let members = 0;
    const hubHandler = (pubOf: () => { verify_key: string; box_key: string; address: string }) => async (url: URL, init: RequestInit) => {
      if (url.pathname === "/v1/agents") return Response.json({ address: "x" }, { status: 201 });
      if (url.pathname.startsWith("/v1/agents/")) return Response.json(pubOf());
      if (url.pathname === "/v1/spaces") return Response.json({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "caspian", epoch: 1 }, { status: 201 });
      if (url.pathname.endsWith("/members")) { members++; return Response.json({ ok: true, epoch: 1 }); }
      if (url.pathname === "/v1/send") { const e = JSON.parse(String(init.body)); sent.push(e); return Response.json({ id: e.id, seq: sent.length }, { status: 202 }); }
      if (url.pathname.endsWith("/board") && init.method === "POST") { const e = JSON.parse(String(init.body)); posts.push(e); return Response.json({ id: e.id, seq: posts.length }, { status: 202 }); }
      if (url.pathname.endsWith("/board")) { const since = Number(url.searchParams.get("since") ?? 0); const page = posts.map((e, i) => ({ seq: i + 1, author: e.from, epoch: 1, envelope: e })).filter((p) => p.seq > since); return Response.json({ posts: page, next: page.length ? page[page.length - 1].seq : since }); }
      return Response.json({ error: "unexpected " + url.pathname }, { status: 500 });
    };
    // owner
    const owner = fakeIo(async () => new Response());
    await join({ ...owner.io, fetch: async (u, i) => hubHandler(() => ({ verify_key: "", box_key: "", address: "" }))(new URL(String(u)), i ?? {}) });
    // member
    const member = fakeIo(async () => new Response());
    await join({ ...member.io, fetch: async () => Response.json({ address: "x" }, { status: 201 }) });
    const memberKeys = decodeKeys(readFileSync(pjoin(member.io.env.AGENTBUS_HOME!, "key.json"), "utf8"));
    const memberPub = { verify_key: toB64(memberKeys.pub.verifyKey), box_key: toB64(memberKeys.pub.boxKey), address: address(memberKeys.pub) };
    const ownerIo: Io = { ...owner.io, fetch: async (u, i) => hubHandler(() => memberPub)(new URL(String(u)), i ?? {}) };

    const key = await spacesCreate(ownerIo, "caspian");
    expect(existsSync(pjoin(owner.io.env.AGENTBUS_HOME!, "spaces", key.space_id + ".json"))).toBe(true);
    await spacesInvite(ownerIo, "caspian", address(memberKeys.pub));
    expect(members).toBe(1);
    expect(sent[0].kind).toBe("invite");

    // member's listener receives the invite frame and stores the key
    const frames = [JSON.stringify({ seq: 1, envelope: sent[0] })];
    const listener = fakeIo(async () => new Response(), frames);
    listener.io.env = member.io.env;
    await listen(listener.io, { once: true });
    expect(listener.err.some((l) => l.startsWith("joined space caspian"))).toBe(true);
    expect(existsSync(pjoin(member.io.env.AGENTBUS_HOME!, "spaces", key.space_id + ".json"))).toBe(true);

    // member posts encrypted; owner reads and gets context
    const memberIo: Io = { ...member.io, fetch: async (u, i) => hubHandler(() => memberPub)(new URL(String(u)), i ?? {}) };
    await post(memberIo, "caspian", "standup at 9");
    expect(JSON.stringify(posts[0])).not.toContain("standup");
    const lines = await read(ownerIo, "caspian");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("standup at 9");
    expect(lines[0]).toContain(address(memberKeys.pub));
    const ctx = await context(ownerIo, "caspian", { max: 10 });
    expect(ctx.split("\n")[0]).toContain("# caspian");
    expect(spacesList(ownerIo)).toHaveLength(1);
  });
});
