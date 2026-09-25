/** agentbus hub: Hono router in front of the Durable Objects. */
import { Hono } from "hono";
import { address, canonical, checkSignedHeaders, isAddress, pubFromJson, sign, verify, fromB64 } from "@agentbus/sdk";
import type { Env } from "./env";
import { Directory } from "./do/directory";

export { Directory };
export { AgentInbox } from "./do/inbox";
export { Space } from "./do/space";

type Vars = { caller: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("main")) as unknown as Directory;

app.get("/health", (c) => c.json({ ok: true }));

/** Register a public identity. Body: {verify_key, box_key, sig} with sig over canonical({verify_key, box_key}). */
app.post("/v1/agents", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { verify_key?: string; box_key?: string; sig?: string } | null;
  if (!body || typeof body.verify_key !== "string" || typeof body.box_key !== "string" || typeof body.sig !== "string") {
    return c.json({ error: "verify_key, box_key, sig required" }, 400);
  }
  let pub;
  try {
    pub = pubFromJson({ verify_key: body.verify_key, box_key: body.box_key });
  } catch {
    return c.json({ error: "bad keys" }, 400);
  }
  const msg = new TextEncoder().encode(canonical({ verify_key: body.verify_key, box_key: body.box_key }));
  let sigOk = false;
  try {
    sigOk = verify(pub, msg, fromB64(body.sig));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return c.json({ error: "signature does not match keys" }, 401);
  const addr = address(pub);
  const created = await directory(c.env).register(addr, body.verify_key, body.box_key);
  return c.json({ address: addr }, created ? 201 : 200);
});

app.get("/v1/agents/:addr", async (c) => {
  const addr = c.req.param("addr");
  if (!isAddress(addr)) return c.json({ error: "malformed address" }, 400);
  const row = await directory(c.env).get(addr);
  if (!row) return c.json({ error: "unknown agent" }, 404);
  return c.json({ address: row.address, verify_key: row.verify_key, box_key: row.box_key, profile: row.profile ? JSON.parse(row.profile) : undefined });
});

/** Middleware for signed (non-envelope) calls. Sets c.var.caller. */
export const signedAuth = async (c: any, next: () => Promise<void>) => {
  const agent = c.req.header("x-agent");
  const row = agent && isAddress(agent) ? await directory(c.env).get(agent) : null;
  const pub = row ? pubFromJson({ verify_key: row.verify_key, box_key: row.box_key }) : null;
  const check = checkSignedHeaders({ get: (n) => c.req.header(n) ?? null }, c.req.method, new URL(c.req.url).pathname, pub);
  if (!check.ok) return c.json({ error: check.reason }, 401);
  c.set("caller", check.address);
  await next();
};

app.get("/v1/whoami", signedAuth, (c) => c.json({ address: c.get("caller") }));

export default app;
