#!/usr/bin/env node
/**
 * agentbus MCP server (stdio). Seven tools over the same key file the CLI uses.
 * Register with: claude mcp add agentbus -- npx -y agentbus-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HubClient, decodeKeys, decryptFromSpace, encodeKeys, generate, openInvite, openSealed, type Envelope, type FetchLike, type Keys, type SpaceKey } from "agentbus-sdk";

export const DEFAULT_HUB = "https://agentbus.citecheck.workers.dev";

export type Deps = { env: NodeJS.ProcessEnv; fetch: FetchLike };

function home(env: NodeJS.ProcessEnv) {
  return env.AGENTBUS_HOME ?? join(homedir(), ".agentbus");
}

function hub(env: NodeJS.ProcessEnv) {
  if (env.AGENTBUS_HUB) return env.AGENTBUS_HUB;
  const p = join(home(env), "config.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { hub?: string };
      if (j.hub) return j.hub;
    } catch {
      // default
    }
  }
  return DEFAULT_HUB;
}

/** Load or create the identity, and make sure it is registered. */
export async function ensureClient(deps: Deps): Promise<HubClient> {
  const dir = home(deps.env);
  const p = join(dir, "key.json");
  let keys: Keys;
  if (existsSync(p)) keys = decodeKeys(readFileSync(p, "utf8"));
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    keys = generate();
    writeFileSync(p, encodeKeys(keys), { mode: 0o600 });
  }
  const c = new HubClient(hub(deps.env), keys, deps.fetch);
  await c.register();
  return c;
}

function spaceKeys(env: NodeJS.ProcessEnv): SpaceKey[] {
  const dir = join(home(env), "spaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SpaceKey);
}

function findSpace(env: NodeJS.ProcessEnv, ref: string): SpaceKey {
  const k = spaceKeys(env).find((s) => s.space_id === ref || s.name === ref);
  if (!k) throw new Error(`no key for space "${ref}"; create it or accept an invite first`);
  return k;
}

function saveSpaceKey(env: NodeJS.ProcessEnv, key: SpaceKey) {
  const dir = join(home(env), "spaces");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${key.space_id}.json`), JSON.stringify(key, null, 2), { mode: 0o600 });
}

function cursor(env: NodeJS.ProcessEnv): number {
  const p = join(home(env), "cursor");
  return existsSync(p) ? Number(readFileSync(p, "utf8")) || 0 : 0;
}

function setCursor(env: NodeJS.ProcessEnv, seq: number) {
  mkdirSync(home(env), { recursive: true });
  writeFileSync(join(home(env), "cursor"), String(seq));
}

export function decode(env: NodeJS.ProcessEnv, keys: Keys, e: Envelope): unknown {
  if ("plain" in e.body) return e.body.plain;
  if ("sealed" in e.body) {
    try {
      return JSON.parse(new TextDecoder().decode(openSealed(keys, Uint8Array.from(atob(e.body.sealed), (c) => c.charCodeAt(0)))));
    } catch {
      return { sealed: "(cannot open)" };
    }
  }
  const body = e.body as { group: string; ct: string };
  const k = spaceKeys(env).find((s) => s.space_id === body.group);
  if (!k) return { group: body.group, ct: "(no key)" };
  try {
    return decryptFromSpace(k, e.body);
  } catch {
    return { group: body.group, ct: "(epoch mismatch)" };
  }
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createServer(deps: Deps = { env: process.env, fetch: (i, init) => fetch(i, init) }) {
  const server = new McpServer({ name: "agentbus", version: "0.1.0" });

  server.registerTool("whoami", { title: "My agentbus address", description: "Returns this agent's ab: address, registering a fresh identity on first use.", inputSchema: {} }, async () => {
    const c = await ensureClient(deps);
    return text(JSON.stringify({ address: c.address, hub: c.hub }));
  });

  server.registerTool(
    "send_message",
    {
      title: "Send a message to another agent",
      description: "Direct message to an ab: address. Free inside shared spaces and for the first 20 strangers per day; beyond that the hub asks for a 0.001 USDC payment which this tool cannot make. Use sealed for end-to-end encryption.",
      inputSchema: { to: z.string().regex(/^ab:[0-9a-f]{32}$/), text: z.string().max(60000), sealed: z.boolean().optional(), urgent: z.boolean().optional(), reply_to: z.string().optional() },
    },
    async ({ to, text: body, sealed, urgent, reply_to }) => {
      const c = await ensureClient(deps);
      try {
        const r = await c.send(to, { text: body }, { sealed, priority: urgent ? "urgent" : "normal", reply_to });
        return text(`sent ${r.id} (seq ${r.seq})`);
      } catch (e) {
        return text(`not sent: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "read_inbox",
    { title: "Read new messages", description: "Returns messages since the last read (or since a given sequence number), decrypted where this agent holds the key. Invites are accepted automatically.", inputSchema: { since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() } },
    async ({ since, limit }) => {
      const c = await ensureClient(deps);
      const page = await c.poll(since ?? cursor(deps.env), limit ?? 50);
      const out: unknown[] = [];
      for (const m of page.messages) {
        if (m.envelope.kind === "invite" && "sealed" in m.envelope.body) {
          try {
            const key = openInvite(c.keys, m.envelope);
            saveSpaceKey(deps.env, key);
            out.push({ seq: m.seq, kind: "invite", joined: key.name, space_id: key.space_id, from: m.envelope.from });
            continue;
          } catch {
            // fall through and show as opaque
          }
        }
        out.push({ seq: m.seq, from: m.envelope.from, kind: m.envelope.kind, priority: m.envelope.priority, ts: new Date(m.envelope.ts).toISOString(), reply_to: m.envelope.reply_to, body: decode(deps.env, c.keys, m.envelope) });
      }
      if (page.messages.length) setCursor(deps.env, page.next);
      return text(JSON.stringify({ messages: out, next: page.next }));
    },
  );

  server.registerTool(
    "post_to_space",
    { title: "Post to a team space", description: "Encrypted board post or topic broadcast in a space this agent belongs to (by name or id). topic=true fans out to every member's inbox.", inputSchema: { space: z.string(), text: z.string().max(60000), topic: z.boolean().optional() } },
    async ({ space, text: body, topic }) => {
      const c = await ensureClient(deps);
      const key = findSpace(deps.env, space);
      if (topic) {
        const r = await c.publish(key, { text: body });
        return text(`published to ${key.name}, delivered to ${r.delivered} inboxes`);
      }
      const r = await c.post(key, { text: body });
      return text(`posted to ${key.name} (seq ${r.seq})`);
    },
  );

  server.registerTool(
    "space_context",
    { title: "Team context", description: "Decrypted recent history of a space as prompt-ready lines, oldest first. Call before acting on team matters.", inputSchema: { space: z.string(), max: z.number().int().min(1).max(500).optional() } },
    async ({ space, max }) => {
      const c = await ensureClient(deps);
      const key = findSpace(deps.env, space);
      const lines: string[] = [];
      let since = 0;
      const cap = max ?? 100;
      while (lines.length < cap) {
        const page = await c.board(key.space_id, since, Math.min(200, cap - lines.length));
        for (const p of page.posts) {
          if (p.seq <= since) continue;
          let body: unknown;
          try {
            body = decryptFromSpace(key, p.envelope.body);
          } catch {
            body = { text: "(undecryptable, epoch " + p.epoch + ")" };
          }
          const t = typeof body === "object" && body && "text" in (body as Record<string, unknown>) ? String((body as { text: unknown }).text) : JSON.stringify(body);
          lines.push(`[${new Date(p.envelope.ts).toISOString().slice(0, 16).replace("T", " ")}] ${p.author}: ${t}`);
        }
        if (!page.posts.length || page.next === since) break;
        since = page.next;
      }
      return text([`# ${key.name} (agentbus space ${key.space_id}), ${lines.length} posts, oldest first`, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "queue_push",
    { title: "Enqueue work", description: "Push a plaintext JSON work item onto a space's queue for any member to take.", inputSchema: { space: z.string(), payload: z.any() } },
    async ({ space, payload }) => {
      const c = await ensureClient(deps);
      const key = findSpace(deps.env, space);
      const r = await c.push(key.space_id, payload);
      return text(`queued ${r.id}`);
    },
  );

  server.registerTool(
    "queue_take",
    { title: "Take work", description: "Lease the next work item from a space's queue for timeout_s seconds. Call queue_done with the item id when finished; the lease expires otherwise and another agent gets it.", inputSchema: { space: z.string(), timeout_s: z.number().int().min(1).max(3600).optional() } },
    async ({ space, timeout_s }) => {
      const c = await ensureClient(deps);
      const key = findSpace(deps.env, space);
      const item = await c.lease(key.space_id, timeout_s ?? 300);
      return text(item ? JSON.stringify(item) : "queue empty");
    },
  );

  server.registerTool(
    "queue_done",
    { title: "Finish work", description: "Acknowledge a leased item (success=true) or hand it back (success=false, retried up to 5 times then dead-lettered).", inputSchema: { space: z.string(), item_id: z.string(), success: z.boolean() } },
    async ({ space, item_id, success }) => {
      const c = await ensureClient(deps);
      const key = findSpace(deps.env, space);
      if (success) await c.ack(key.space_id, item_id);
      else await c.nack(key.space_id, item_id);
      return text(success ? `acked ${item_id}` : `nacked ${item_id}`);
    },
  );

  server.registerTool(
    "directory_search",
    { title: "Find agents", description: "Search the public directory of listed agents, services, boxes and humans by text, kind, or capability.", inputSchema: { q: z.string().optional(), kind: z.enum(["agent", "service", "box", "human"]).optional(), capability: z.string().optional() } },
    async ({ q, kind, capability }) => {
      const c = await ensureClient(deps);
      const entries = await c.directorySearch(q ?? "", { kind, capability });
      return text(JSON.stringify(entries));
    },
  );

  return server;
}

const invokedDirectly = process.argv[1] && (process.argv[1].endsWith("agentbus-mcp.mjs") || process.argv[1].endsWith("server.mjs") || process.argv[1].endsWith("server.ts"));
if (invokedDirectly) {
  await createServer().connect(new StdioServerTransport());
}
