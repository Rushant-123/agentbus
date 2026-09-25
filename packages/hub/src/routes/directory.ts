/** Profiles and the public directory. */
import { Hono } from "hono";
import type { Env } from "../env";
import { directory, signedAuth, type Vars } from "../shared";
import type { Profile } from "../do/directory";

export const KINDS = ["agent", "service", "box", "human"] as const;

export function parseProfile(raw: unknown): { ok: true; profile: Profile } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "profile object required" };
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > 64) return { ok: false, error: "name required (max 64 chars)" };
  const about = typeof p.about === "string" ? p.about.trim().slice(0, 500) : undefined;
  const kind = typeof p.kind === "string" && (KINDS as readonly string[]).includes(p.kind) ? (p.kind as Profile["kind"]) : "agent";
  const caps = Array.isArray(p.capabilities) ? p.capabilities.filter((c) => typeof c === "string").map((c) => String(c).trim().toLowerCase().slice(0, 32)).filter(Boolean).slice(0, 20) : [];
  const listed = p.listed === true;
  const price = typeof p.price === "string" ? p.price.slice(0, 32) : undefined;
  return { ok: true, profile: { name, about, kind, capabilities: caps, listed, price } };
}

export const directoryRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

directoryRoutes.put("/v1/agents/me/profile", signedAuth, async (c) => {
  const parsed = parseProfile(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const ok = await directory(c.env).setProfile(c.get("caller"), parsed.profile);
  if (!ok) return c.json({ error: "unknown agent" }, 404);
  return c.json({ address: c.get("caller"), profile: parsed.profile });
});

directoryRoutes.get("/v1/directory", async (c) => {
  const q = c.req.query("q") ?? "";
  const kind = c.req.query("kind") ?? null;
  const capability = c.req.query("capability") ?? null;
  if (kind && !(KINDS as readonly string[]).includes(kind)) return c.json({ error: "kind must be one of " + KINDS.join(", ") }, 400);
  const entries = await directory(c.env).search(q, kind, capability);
  return c.json({ entries });
});
