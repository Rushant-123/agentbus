/** CLI commands with injectable I/O so they are testable without a network or a terminal. */
import { spawn } from "node:child_process";
import { HubClient, openSealed, type Envelope, type FetchLike, type Keys } from "@agentbus/sdk";
import { hubUrl, loadKeys, loadOrCreateKeys, readCursor, writeCursor } from "./config";

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

export type ListenOpts = { exec?: string; json?: boolean; once?: boolean; since?: number };

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
      const decoded = { seq: m.seq, from: m.envelope.from, kind: m.envelope.kind, priority: m.envelope.priority, ts: m.envelope.ts, reply_to: m.envelope.reply_to, body: decodeBody(keys, m.envelope) };
      if (opts.exec) {
        const task = io
          .exec(opts.exec, JSON.stringify(decoded), { AGENTBUS_FROM: m.envelope.from, AGENTBUS_KIND: m.envelope.kind, AGENTBUS_SEQ: String(m.seq) })
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
