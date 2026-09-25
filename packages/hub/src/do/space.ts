/** Space DO: membership, key epoch, encrypted board. Topic and queue arrive in Task 9. */
import { DurableObject } from "cloudflare:workers";
import type { Envelope } from "@agentbus/sdk";
import type { Env } from "../env";

export type SpaceInfo = { id: string; name: string; owner: string; epoch: number; members: string[]; created: number };
export type BoardPage = { posts: { seq: number; author: string; epoch: number; envelope: Envelope }[]; next: number };
export type PostResult = { ok: true; seq: number } | { ok: false; status: 403 | 400 | 409; error: string };

export class Space extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS members(address TEXT PRIMARY KEY, added INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS posts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, author TEXT NOT NULL, epoch INTEGER NOT NULL, envelope TEXT NOT NULL, ts INTEGER NOT NULL)`);
    });
  }

  private meta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? String(rows[0].value) : null;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  isMember(address: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM members WHERE address = ?", address).toArray().length > 0;
  }

  async create(id: string, name: string, owner: string): Promise<boolean> {
    if (this.meta("id")) return false;
    this.setMeta("id", id);
    this.setMeta("name", name);
    this.setMeta("owner", owner);
    this.setMeta("epoch", "1");
    this.setMeta("created", String(Date.now()));
    this.ctx.storage.sql.exec("INSERT INTO members(address, added) VALUES (?, ?)", owner, Date.now());
    return true;
  }

  async info(caller: string): Promise<SpaceInfo | null> {
    const id = this.meta("id");
    if (!id || !this.isMember(caller)) return null;
    const members = this.ctx.storage.sql.exec("SELECT address FROM members ORDER BY added").toArray().map((r) => String(r.address));
    return { id, name: this.meta("name") ?? "", owner: this.meta("owner") ?? "", epoch: Number(this.meta("epoch") ?? 1), members, created: Number(this.meta("created") ?? 0) };
  }

  /** Owner only. Returns the current epoch so the caller can seal the right key into the invite. */
  async addMember(caller: string, address: string): Promise<{ ok: boolean; status: number; epoch: number }> {
    if (!this.meta("id")) return { ok: false, status: 404, epoch: 0 };
    if (this.meta("owner") !== caller) return { ok: false, status: 403, epoch: 0 };
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO members(address, added) VALUES (?, ?)", address, Date.now());
    return { ok: true, status: 200, epoch: Number(this.meta("epoch")) };
  }

  /** Owner only. Removal bumps the epoch; the owner must re-invite remaining members with a new key. */
  async removeMember(caller: string, address: string): Promise<{ ok: boolean; status: number; epoch: number }> {
    if (!this.meta("id")) return { ok: false, status: 404, epoch: 0 };
    if (this.meta("owner") !== caller) return { ok: false, status: 403, epoch: 0 };
    if (address === this.meta("owner")) return { ok: false, status: 400, epoch: Number(this.meta("epoch")) };
    this.ctx.storage.sql.exec("DELETE FROM members WHERE address = ?", address);
    const epoch = Number(this.meta("epoch")) + 1;
    this.setMeta("epoch", String(epoch));
    return { ok: true, status: 200, epoch };
  }

  /** Members only. Envelope is already signature-checked by the Worker. Body must be group-encrypted for this space. */
  async post(env: Envelope): Promise<PostResult> {
    const id = this.meta("id");
    if (!id) return { ok: false, status: 400, error: "no such space" };
    if (!this.isMember(env.from)) return { ok: false, status: 403, error: "not a member" };
    if (!("group" in env.body) || env.body.group !== id) return { ok: false, status: 400, error: "body must be group-encrypted for this space" };
    if (env.to !== `space:${id}`) return { ok: false, status: 400, error: "envelope must be addressed to the space" };
    const existing = this.ctx.storage.sql.exec("SELECT seq FROM posts WHERE id = ?", env.id).toArray();
    if (existing.length) return { ok: true, seq: Number(existing[0].seq) };
    const epoch = Number(this.meta("epoch"));
    this.ctx.storage.sql.exec("INSERT INTO posts(id, author, epoch, envelope, ts) VALUES (?, ?, ?, ?, ?)", env.id, env.from, epoch, JSON.stringify(env), Date.now());
    const seq = Number(this.ctx.storage.sql.exec("SELECT seq FROM posts WHERE id = ?", env.id).one().seq);
    return { ok: true, seq };
  }

  async board(caller: string, since: number, limit: number): Promise<BoardPage | null> {
    if (!this.meta("id") || !this.isMember(caller)) return null;
    const lim = Math.min(Math.max(limit, 1), 200);
    const rows = this.ctx.storage.sql.exec("SELECT seq, author, epoch, envelope FROM posts WHERE seq > ? ORDER BY seq LIMIT ?", since, lim).toArray();
    const posts = rows.map((r) => ({ seq: Number(r.seq), author: String(r.author), epoch: Number(r.epoch), envelope: JSON.parse(String(r.envelope)) as Envelope }));
    return { posts, next: posts.length ? posts[posts.length - 1].seq : since };
  }
}
