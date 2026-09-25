/** Directory DO (singleton): agent registry, profiles, and space membership index. */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export type AgentRow = { address: string; verify_key: string; box_key: string; profile: string | null; created: number };
export type Profile = { name: string; about?: string; kind: "agent" | "service" | "box" | "human"; capabilities: string[]; listed: boolean; price?: string };
export type DirectoryEntry = { address: string; profile: Profile };

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agents(
        address TEXT PRIMARY KEY, verify_key TEXT NOT NULL, box_key TEXT NOT NULL, profile TEXT, created INTEGER NOT NULL)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS memberships(
        space_id TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY(space_id, address))`);
      ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS memberships_addr ON memberships(address)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS stranger_sends(address TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(address, day))`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rate(address TEXT NOT NULL, lane TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(address, lane, minute))`);
    });
  }

  /** Returns true when newly created, false when it already existed. */
  async register(address: string, verify_key: string, box_key: string): Promise<boolean> {
    const existing = this.ctx.storage.sql.exec("SELECT address FROM agents WHERE address = ?", address).toArray();
    if (existing.length) return false;
    this.ctx.storage.sql.exec("INSERT INTO agents(address, verify_key, box_key, created) VALUES (?, ?, ?, ?)", address, verify_key, box_key, Date.now());
    return true;
  }

  async get(address: string): Promise<AgentRow | null> {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM agents WHERE address = ?", address).toArray();
    return rows.length ? (rows[0] as unknown as AgentRow) : null;
  }

  async addMembership(spaceId: string, address: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO memberships(space_id, address) VALUES (?, ?)", spaceId, address);
  }

  async removeMembership(spaceId: string, address: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM memberships WHERE space_id = ? AND address = ?", spaceId, address);
  }

  async sharesSpace(a: string, b: string): Promise<boolean> {
    const rows = this.ctx.storage.sql
      .exec("SELECT 1 FROM memberships m1 JOIN memberships m2 ON m1.space_id = m2.space_id WHERE m1.address = ? AND m2.address = ? LIMIT 1", a, b)
      .toArray();
    return rows.length > 0;
  }

  // Stranger allowance and rate limits (counters live here because the Directory is a singleton).

  async strangerCount(address: string, day: string): Promise<number> {
    const rows = this.ctx.storage.sql.exec("SELECT count FROM stranger_sends WHERE address = ? AND day = ?", address, day).toArray();
    return rows.length ? Number(rows[0].count) : 0;
  }

  async bumpStranger(address: string, day: string): Promise<number> {
    this.ctx.storage.sql.exec(
      "INSERT INTO stranger_sends(address, day, count) VALUES (?, ?, 1) ON CONFLICT(address, day) DO UPDATE SET count = count + 1",
      address, day,
    );
    return this.strangerCount(address, day);
  }

  /** Increments the per-minute counter and returns the new value. Caller compares against the lane limit. */
  async rateHit(address: string, lane: "inspace" | "stranger", minute: number): Promise<number> {
    this.ctx.storage.sql.exec(
      "INSERT INTO rate(address, lane, minute, count) VALUES (?, ?, ?, 1) ON CONFLICT(address, lane, minute) DO UPDATE SET count = count + 1",
      address, lane, minute,
    );
    // opportunistic cleanup of old minutes
    if (Math.random() < 0.05) this.ctx.storage.sql.exec("DELETE FROM rate WHERE minute < ?", minute - 5);
    return Number(this.ctx.storage.sql.exec("SELECT count FROM rate WHERE address = ? AND lane = ? AND minute = ?", address, lane, minute).one().count);
  }

  // Profiles and the public directory

  async setProfile(address: string, profile: Profile): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec("SELECT 1 FROM agents WHERE address = ?", address).toArray();
    if (!rows.length) return false;
    this.ctx.storage.sql.exec("UPDATE agents SET profile = ? WHERE address = ?", JSON.stringify(profile), address);
    return true;
  }

  /** Listed profiles matching q (name/about substring, case-insensitive), kind, and capability. */
  async search(q: string, kind: string | null, capability: string | null, limit = 50): Promise<DirectoryEntry[]> {
    const rows = this.ctx.storage.sql.exec("SELECT address, profile FROM agents WHERE profile IS NOT NULL ORDER BY created DESC LIMIT 5000").toArray();
    const needle = q.trim().toLowerCase();
    const out: DirectoryEntry[] = [];
    for (const r of rows) {
      let p: Profile;
      try {
        p = JSON.parse(String(r.profile)) as Profile;
      } catch {
        continue;
      }
      if (!p.listed) continue;
      if (kind && p.kind !== kind) continue;
      if (capability && !p.capabilities.map((c) => c.toLowerCase()).includes(capability.toLowerCase())) continue;
      if (needle && !(p.name.toLowerCase().includes(needle) || (p.about ?? "").toLowerCase().includes(needle))) continue;
      out.push({ address: String(r.address), profile: p });
      if (out.length >= limit) break;
    }
    return out;
  }
}
