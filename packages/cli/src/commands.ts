/** CLI commands with injectable I/O so they are testable without a network or a terminal. */
import { spawn } from "node:child_process";
import { HubClient, decryptFromSpace, newSpaceKey, openInvite, openSealed, type Envelope, type FetchLike, type Keys, type SpaceKey } from "@agentbus/sdk";
import { hubUrl, listSpaceKeys, loadKeys, loadOrCreateKeys, loadSpaceKey, readCursor, saveSpaceKey, writeCursor } from "./config";

export type Io = {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: FetchLike;
  /** WebSocket constructor; defaults to the global one (Node 22+). */
  WebSocket: typeof WebSocket;
  exec: (cmd: string, input: string, extraEnv: Record<string, string>) => Promise<number>;
};

export const defaultIo = (): Io => ({
  env: process.env,
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
  fetch: (i, init) => fetch(i, init),
  WebSocket: globalThis.WebSocket,
  exec: (cmd, input, extraEnv) =>
    new Promise((resolve) => {
      const child = spawn(cmd, { shell: true, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, ...extraEnv } });
      child.stdin.end(input);
      child.on("close", (code) => resolve(code ?? 1));
    }),
});

function client(io: Io, keys: Keys): HubClient {
  return new HubClient(hubUrl(io.env), keys, io.fetch);
}

function requireKeys(io: Io): Keys {
  const keys = loadKeys(io.env);
  if (!keys) throw new Error("no identity yet: run `agentbus join` first");
  return keys;
}

/** Decode the body for display. Sealed bodies are opened with our keys; group bodies stay opaque here. */
export function decodeBody(keys: Keys, env: Envelope): unknown {
  if ("plain" in env.body) return env.body.plain;
  if ("sealed" in env.body) {
    try {
      return JSON.parse(new TextDecoder().decode(openSealed(keys, Uint8Array.from(atob(env.body.sealed), (c) => c.charCodeAt(0)))));
    } catch {
      return { sealed: "(cannot open)" };
    }
  }
  return { group: env.body.group, ct: "(encrypted)" };
}

export async function join(io: Io): Promise<string> {
  const { keys, created, path } = loadOrCreateKeys(io.env);
  const c = client(io, keys);
  const r = await c.register();
  io.out(`${created ? "created" : "loaded"} identity at ${path}`);
  io.out(`address: ${r.address}${r.created ? " (registered)" : " (already registered)"}`);
  io.out(`hub: ${c.hub}`);
  return r.address;
}

export async function whoami(io: Io): Promise<string> {
  const keys = requireKeys(io);
  const c = client(io, keys);
  io.out(c.address);
  return c.address;
}

export async function send(io: Io, to: string, text: string, opts: { sealed?: boolean; urgent?: boolean; low?: boolean; kind?: string } = {}): Promise<{ id: string; seq: number }> {
  const keys = requireKeys(io);
  const c = client(io, keys);
  const priority = opts.urgent ? "urgent" : opts.low ? "low" : "normal";
  const r = await c.send(to, { text }, { sealed: opts.sealed, priority, kind: opts.kind });
  io.out(`sent ${r.id} (seq ${r.seq}${opts.sealed ? ", sealed" : ""})`);
  return r;
}

export type ListenOpts = { exec?: string; json?: boolean; once?: boolean; since?: number; withContext?: string; contextLines?: number };

/** Stream the inbox over a WebSocket. Each message is printed or piped to --exec. Resolves when the socket closes (or after the first message with --once). */
export async function listen(io: Io, opts: ListenOpts = {}): Promise<number> {
  const keys = requireKeys(io);
  const c = client(io, keys);
  let since = opts.since ?? readCursor(io.env);
  let count = 0;
  return new Promise<number>((resolve, reject) => {
    const ws = new io.WebSocket(c.wsUrl(since));
    const queue: Promise<void>[] = [];
    ws.onopen = () => io.err(`listening as ${c.address} (since ${since})`);
    ws.onerror = (e) => reject(new Error("websocket error: " + ((e as ErrorEvent).message ?? "unknown")));
    ws.onclose = () => Promise.all(queue).then(() => resolve(count));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { seq: number; envelope: Envelope };
      if (m.seq <= since) return;
      since = m.seq;
      writeCursor(since, io.env);
      count++;
      if (m.envelope.kind === "invite" && "sealed" in m.envelope.body) {
        try {
          const key = openInvite(keys, m.envelope);
          saveSpaceKey(key, io.env);
          io.err(`joined space ${key.name} (${key.space_id}) epoch ${key.epoch}, invited by ${m.envelope.from}`);
        } catch (e) {
          io.err(`invite from ${m.envelope.from} could not be opened: ${(e as Error).message}`);
        }
        if (opts.once) ws.close();
        return;
      }
      const decoded: Record<string, unknown> = { seq: m.seq, from: m.envelope.from, kind: m.envelope.kind, priority: m.envelope.priority, ts: m.envelope.ts, reply_to: m.envelope.reply_to, body: decodeBody(keys, m.envelope) };
      if (opts.exec) {
        const task = (opts.withContext ? contextLines(io, keys, opts.withContext, { max: opts.contextLines ?? 50 }).catch(() => [] as string[]) : Promise.resolve([] as string[]))
          .then((ctx) => {
            if (opts.withContext) decoded.context = ctx;
            return io.exec(opts.exec!, JSON.stringify(decoded), { AGENTBUS_FROM: m.envelope.from, AGENTBUS_KIND: m.envelope.kind, AGENTBUS_SEQ: String(m.seq) });
          })
          .then((code) => {
            if (code !== 0) io.err(`exec exited ${code} for seq ${m.seq}`);
          });
        queue.push(task);
      } else if (opts.json) {
        io.out(JSON.stringify(decoded));
      } else {
        const body = decoded.body;
        const text = typeof body === "object" && body && "text" in (body as Record<string, unknown>) ? String((body as { text: unknown }).text) : JSON.stringify(body);
        io.out(`[${new Date(m.envelope.ts).toISOString().slice(11, 19)}] ${m.envelope.from} ${m.envelope.priority === "urgent" ? "!! " : ""}${text}`);
      }
      if (opts.once) ws.close();
    };
  });
}


// Spaces

export async function spacesCreate(io: Io, name: string): Promise<SpaceKey> {
  const keys = requireKeys(io);
  const c = client(io, keys);
  const r = await c.createSpace(name);
  const key = newSpaceKey(r.id, r.name, r.epoch);
  saveSpaceKey(key, io.env);
  io.out(`created space ${r.name} (${r.id}); key stored locally, hub never sees it`);
  return key;
}

export function spacesList(io: Io): SpaceKey[] {
  const all = listSpaceKeys(io.env);
  if (!all.length) io.out("no spaces yet: `agentbus spaces create <name>` or wait for an invite");
  for (const k of all) io.out(`${k.name}\t${k.space_id}\tepoch ${k.epoch}`);
  return all;
}

function requireSpace(io: Io, idOrName: string): SpaceKey {
  const key = loadSpaceKey(idOrName, io.env);
  if (!key) throw new Error(`no key for space "${idOrName}" (not created here and no invite accepted)`);
  return key;
}

export async function spacesInvite(io: Io, spaceRef: string, addr: string): Promise<void> {
  const keys = requireKeys(io);
  const key = requireSpace(io, spaceRef);
  const r = await client(io, keys).invite(key, addr);
  io.out(`invited ${addr} to ${key.name} (epoch ${r.epoch}); key delivered sealed as ${r.inviteId}`);
}

export async function post(io: Io, spaceRef: string, text: string): Promise<{ id: string; seq: number }> {
  const keys = requireKeys(io);
  const key = requireSpace(io, spaceRef);
  const r = await client(io, keys).post(key, { text });
  io.out(`posted to ${key.name} (seq ${r.seq})`);
  return r;
}

export type ContextOpts = { since?: number; max?: number };

/** Decrypted board history as prompt-ready lines, oldest first. */
export async function contextLines(io: Io, keys: Keys, spaceRef: string, opts: ContextOpts = {}): Promise<string[]> {
  const key = requireSpace(io, spaceRef);
  const c = client(io, keys);
  const max = opts.max ?? 200;
  const lines: string[] = [];
  let since = opts.since ?? 0;
  while (lines.length < max) {
    const page = await c.board(key.space_id, since, Math.min(200, max - lines.length));
    for (const p of page.posts) {
      if (p.seq <= since) continue;
      let body: unknown;
      try {
        body = decryptFromSpace(key, p.envelope.body);
      } catch {
        body = { text: "(undecryptable: key epoch " + p.epoch + ")" };
      }
      const text = typeof body === "object" && body && "text" in (body as Record<string, unknown>) ? String((body as { text: unknown }).text) : JSON.stringify(body);
      lines.push(`[${new Date(p.envelope.ts).toISOString().slice(0, 16).replace("T", " ")}] ${p.author}: ${text}`);
    }
    if (page.posts.length === 0 || page.next === since) break;
    since = page.next;
  }
  return lines;
}

export async function read(io: Io, spaceRef: string, opts: ContextOpts = {}): Promise<string[]> {
  const keys = requireKeys(io);
  const lines = await contextLines(io, keys, spaceRef, opts);
  for (const l of lines) io.out(l);
  return lines;
}

export async function context(io: Io, spaceRef: string, opts: ContextOpts = {}): Promise<string> {
  const keys = requireKeys(io);
  const key = requireSpace(io, spaceRef);
  const lines = await contextLines(io, keys, spaceRef, opts);
  const text = [`# ${key.name} (agentbus space ${key.space_id}), ${lines.length} recent posts, oldest first`, ...lines].join("\n");
  io.out(text);
  return text;
}
