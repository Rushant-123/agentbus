/** Helpers shared by route modules: directory stub and signed-request middleware. */
import type { Context, Next } from "hono";
import { checkSignedHeaders, isAddress, pubFromJson } from "@agentbus/sdk";
import type { Env } from "./env";
import type { Directory } from "./do/directory";

export type Vars = { caller: string };

export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("main")) as unknown as Directory;

export const signedAuth = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) => {
  const agent = c.req.header("x-agent");
  const row = agent && isAddress(agent) ? await directory(c.env).get(agent) : null;
  const pub = row ? pubFromJson({ verify_key: row.verify_key, box_key: row.box_key }) : null;
  const check = checkSignedHeaders({ get: (n) => c.req.header(n) ?? null }, c.req.method, new URL(c.req.url).pathname, pub);
  if (!check.ok) return c.json({ error: check.reason }, 401);
  c.set("caller", check.address);
  await next();
};
