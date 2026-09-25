/** POST /v1/send and GET /v1/inbox. */
import { Hono } from "hono";
import { isAddress, pubFromJson, sizeOk, verifyEnvelope, type Envelope } from "@agentbus/sdk";
import type { Env } from "../env";
import type { AgentInbox } from "../do/inbox";
import { directory, signedAuth, type Vars } from "../shared";
import { checkSignedHeaders } from "@agentbus/sdk";

export const inbox = (env: Env, addr: string) => env.INBOX.get(env.INBOX.idFromName(addr)) as unknown as AgentInbox;

export const messaging = new Hono<{ Bindings: Env; Variables: Vars }>();

messaging.post("/v1/send", async (c) => {
  const env = (await c.req.json().catch(() => null)) as Envelope | null;
  if (!env || typeof env !== "object") return c.json({ error: "envelope required" }, 400);
  if (!isAddress(env.from) || !isAddress(env.to)) return c.json({ error: "from and to must be ab: addresses" }, 400);
  if (!sizeOk(env)) return c.json({ error: "envelope over 64 KB" }, 413);
  const dir = directory(c.env);
  const sender = await dir.get(env.from);
  if (!sender) return c.json({ error: "unknown sender" }, 401);
  if (!verifyEnvelope(env, pubFromJson({ verify_key: sender.verify_key, box_key: sender.box_key }))) {
    return c.json({ error: "bad signature" }, 401);
  }
  const recipient = await dir.get(env.to);
  if (!recipient) return c.json({ error: "unknown recipient" }, 404);
  const { seq } = await inbox(c.env, env.to).deliver(env);
  return c.json({ id: env.id, seq }, 202);
});

messaging.get("/v1/inbox", signedAuth, async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const limit = Number(c.req.query("limit") ?? 50);
  if (!Number.isFinite(since) || since < 0) return c.json({ error: "since must be a non-negative integer" }, 400);
  const page = await inbox(c.env, c.get("caller")).list(since, Number.isFinite(limit) ? limit : 50);
  return c.json(page);
});

/** WebSocket upgrade. Auth via query (browsers cannot set headers on upgrades): agent, ts, sig over "GET /v1/inbox/ws". */
messaging.get("/v1/inbox/ws", async (c) => {
  const q = c.req.query();
  const agent = q.agent;
  const row = agent && isAddress(agent) ? await directory(c.env).get(agent) : null;
  const pub = row ? pubFromJson({ verify_key: row.verify_key, box_key: row.box_key }) : null;
  const headers = { get: (n: string) => ({ "x-agent": q.agent, "x-ts": q.ts, "x-sig": q.sig } as Record<string, string | undefined>)[n] ?? null };
  const check = checkSignedHeaders(headers, "GET", "/v1/inbox/ws", pub);
  if (!check.ok) return c.json({ error: check.reason }, 401);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket upgrade" }, 426);
  const stub = c.env.INBOX.get(c.env.INBOX.idFromName(check.address));
  return stub.fetch(c.req.raw);
});
