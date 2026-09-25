/** Directory DO (singleton): agent registry, profiles, and space membership index. */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export type AgentRow = { address: string; verify_key: string; box_key: string; profile: string | null; created: number };

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS agents(
        address TEXT PRIMARY KEY, verify_key TEXT NOT NULL, box_key TEXT NOT NULL, profile TEXT, created INTEGER NOT NULL)`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS memberships(
        space_id TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY(space_id, address))`);
      ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS memberships_addr ON memberships(address)`);
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
}
