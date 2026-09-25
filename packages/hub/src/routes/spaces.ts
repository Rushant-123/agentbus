/** Space routes: create, members, board. */
import { Hono } from "hono";
import { isAddress, pubFromJson, sizeOk, ulid, verifyEnvelope, type Envelope } from "@agentbus/sdk";
import type { Env } from "../env";
import type { Space } from "../do/space";
import { directory, signedAuth, type Vars } from "../shared";

export const space = (env: Env, id: string) => env.SPACE.get(env.SPACE.idFromName(id)) as unknown as Space;

const SPACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const spaces = new Hono<{ Bindings: Env; Variables: Vars }>();

spaces.post("/v1/spaces", signedAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name || name.length > 64) return c.json({ error: "name required (max 64 chars)" }, 400);
  const id = ulid();
  await space(c.env, id).create(id, name, c.get("caller"));
  await directory(c.env).addMembership(id, c.get("caller"));
  return c.json({ id, name, epoch: 1 }, 201);
});

spaces.get("/v1/spaces/:id", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const info = await space(c.env, id).info(c.get("caller"));
  if (!info) return c.json({ error: "not a member or no such space" }, 403);
  return c.json(info);
});

spaces.post("/v1/spaces/:id/members", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const body = (await c.req.json().catch(() => null)) as { address?: string } | null;
  if (!body || !isAddress(body.address)) return c.json({ error: "address required" }, 400);
  const dir = directory(c.env);
  if (!(await dir.get(body.address))) return c.json({ error: "unknown agent" }, 404);
  const r = await space(c.env, id).addMember(c.get("caller"), body.address);
  if (!r.ok) return c.json({ error: r.status === 403 ? "owner only" : "no such space" }, r.status as 403 | 404);
  await dir.addMembership(id, body.address);
  return c.json({ ok: true, epoch: r.epoch });
});

spaces.delete("/v1/spaces/:id/members/:addr", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  const addr = (c.req.param("addr") ?? "");
  if (!SPACE_ID.test(id) || !isAddress(addr)) return c.json({ error: "malformed id or address" }, 400);
  const r = await space(c.env, id).removeMember(c.get("caller"), addr);
  if (!r.ok) return c.json({ error: r.status === 403 ? "owner only" : r.status === 400 ? "cannot remove owner" : "no such space" }, r.status as 400 | 403 | 404);
  await directory(c.env).removeMembership(id, addr);
  return c.json({ ok: true, epoch: r.epoch });
});

/** Board post: a signed envelope addressed to space:<id> with a group-encrypted body. */
spaces.post("/v1/spaces/:id/board", async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const env = (await c.req.json().catch(() => null)) as Envelope | null;
  if (!env || typeof env !== "object" || !isAddress(env.from)) return c.json({ error: "envelope required" }, 400);
  if (!sizeOk(env)) return c.json({ error: "envelope over 64 KB" }, 413);
  const sender = await directory(c.env).get(env.from);
  if (!sender || !verifyEnvelope(env, pubFromJson({ verify_key: sender.verify_key, box_key: sender.box_key }))) {
    return c.json({ error: "bad signature" }, 401);
  }
  const r = await space(c.env, id).post(env);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ id: env.id, seq: r.seq }, 202);
});

spaces.get("/v1/spaces/:id/board", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const since = Number(c.req.query("since") ?? 0);
  const limit = Number(c.req.query("limit") ?? 100);
  const page = await space(c.env, id).board(c.get("caller"), Number.isFinite(since) ? since : 0, Number.isFinite(limit) ? limit : 100);
  if (!page) return c.json({ error: "not a member or no such space" }, 403);
  return c.json(page);
});

// Topic

spaces.post("/v1/spaces/:id/topic", async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const env = (await c.req.json().catch(() => null)) as Envelope | null;
  if (!env || typeof env !== "object" || !isAddress(env.from)) return c.json({ error: "envelope required" }, 400);
  if (!sizeOk(env)) return c.json({ error: "envelope over 64 KB" }, 413);
  const sender = await directory(c.env).get(env.from);
  if (!sender || !verifyEnvelope(env, pubFromJson({ verify_key: sender.verify_key, box_key: sender.box_key }))) {
    return c.json({ error: "bad signature" }, 401);
  }
  const r = await space(c.env, id).publish(env);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ id: env.id, delivered: r.delivered }, 202);
});

spaces.put("/v1/spaces/:id/topic/subscription", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null;
  if (!body || typeof body.enabled !== "boolean") return c.json({ error: "enabled (boolean) required" }, 400);
  const ok = await space(c.env, id).setSubscription(c.get("caller"), body.enabled);
  if (!ok) return c.json({ error: "not a member or no such space" }, 403);
  return c.json({ ok: true, enabled: body.enabled });
});

// Queue

spaces.post("/v1/spaces/:id/queue", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const body = (await c.req.json().catch(() => null)) as { payload?: unknown; id?: string } | null;
  if (!body || body.payload === undefined) return c.json({ error: "payload required" }, 400);
  if (JSON.stringify(body.payload).length > 65536) return c.json({ error: "payload over 64 KB" }, 413);
  const itemId = typeof body.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : ulid();
  const r = await space(c.env, id).push(c.get("caller"), itemId, body.payload);
  if (!r.ok) return c.json({ error: r.status === 403 ? "not a member" : "no such space" }, r.status as 403 | 404);
  return c.json({ id: itemId }, 201);
});

spaces.post("/v1/spaces/:id/queue/lease", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { timeout_s?: number };
  const r = await space(c.env, id).lease(c.get("caller"), Number(body.timeout_s ?? 30));
  if (r.status === 204) return c.body(null, 204);
  if (r.status !== 200) return c.json({ error: r.status === 403 ? "not a member" : "no such space" }, r.status as 403 | 404);
  return c.json({ item: r.item });
});

spaces.post("/v1/spaces/:id/queue/:item/ack", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const status = await space(c.env, id).ack(c.get("caller"), c.req.param("item") ?? "");
  return status === 200 ? c.json({ ok: true }) : c.json({ error: status === 409 ? "no live lease held by caller" : status === 404 ? "no such item" : "not a member" }, status as 403 | 404 | 409);
});

spaces.post("/v1/spaces/:id/queue/:item/nack", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const status = await space(c.env, id).nack(c.get("caller"), c.req.param("item") ?? "");
  return status === 200 ? c.json({ ok: true }) : c.json({ error: status === 409 ? "no live lease held by caller" : status === 404 ? "no such item" : "not a member" }, status as 403 | 404 | 409);
});

spaces.get("/v1/spaces/:id/queue", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const stats = await space(c.env, id).queueStats(c.get("caller"));
  if (!stats) return c.json({ error: "not a member or no such space" }, 403);
  return c.json(stats);
});

spaces.get("/v1/spaces/:id/queue/dead", signedAuth, async (c) => {
  const id = (c.req.param("id") ?? "");
  if (!SPACE_ID.test(id)) return c.json({ error: "malformed space id" }, 400);
  const items = await space(c.env, id).dead(c.get("caller"));
  if (!items) return c.json({ error: "not a member or no such space" }, 403);
  return c.json({ items });
});
