import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { describe, expect, it } from "vitest";
import { address, build, decodeKeys, generate, seal, toB64, verifyEnvelope, type Envelope } from "@agentbus/sdk";
import { join, listen, send, whoami, type Io } from "../src/commands";
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
