/** Space DO: membership, key epoch, encrypted board, topic fan-out, work queue. */
import { DurableObject } from "cloudflare:workers";
import type { Envelope } from "@agentbus/sdk";
import type { Env } from "../env";
import type { AgentInbox } from "./inbox";

export type SpaceInfo = { id: string; name: string; owner: string; epoch: number; members: string[]; created: number };
export type BoardPage = { posts: { seq: number; author: string; epoch: number; envelope: Envelope }[]; next: number };
export type PostResult = { ok: true; seq: number } | { ok: false; status: 403 | 400 | 409; error: string };
export type PublishResult = { ok: true; delivered: number } | { ok: false; status: 403 | 400; error: string };
export type QueueItem = { id: string; payload: unknown; attempts: number; lease_until: number; created: number };
export type QueueStats = { ready: number; leased: number; done: number; dead: number };
export const MAX_ATTEMPTS = 5;

export class Space extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS members(address TEXT PRIMARY KEY, added INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS posts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, author TEXT NOT NULL, epoch INTEGER NOT NULL, envelope TEXT NOT NULL, ts INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS muted(address TEXT PRIMARY KEY)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS published(id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS items(
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, leased_by TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, done_at INTEGER)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS items_state ON items(state, created)`);
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

  // Topic: encrypted publish fanned out to every other member's inbox.

  async setSubscription(caller: string, enabled: boolean): Promise<boolean> {
    if (!this.meta("id") || !this.isMember(caller)) return false;
    if (enabled) this.ctx.storage.sql.exec("DELETE FROM muted WHERE address = ?", caller);
    else this.ctx.storage.sql.exec("INSERT OR IGNORE INTO muted(address) VALUES (?)", caller);
    return true;
  }

  async publish(env: Envelope): Promise<PublishResult> {
    const id = this.meta("id");
    if (!id) return { ok: false, status: 400, error: "no such space" };
    if (!this.isMember(env.from)) return { ok: false, status: 403, error: "not a member" };
    if (!("group" in env.body) || env.body.group !== id) return { ok: false, status: 400, error: "body must be group-encrypted for this space" };
    if (env.to !== `space:${id}`) return { ok: false, status: 400, error: "envelope must be addressed to the space" };
    if (this.ctx.storage.sql.exec("SELECT 1 FROM published WHERE id = ?", env.id).toArray().length) return { ok: true, delivered: 0 };
    this.ctx.storage.sql.exec("INSERT INTO published(id, ts) VALUES (?, ?)", env.id, Date.now());
    const targets = this.ctx.storage.sql
      .exec("SELECT address FROM members WHERE address != ? AND address NOT IN (SELECT address FROM muted)", env.from)
      .toArray()
      .map((r) => String(r.address));
    let delivered = 0;
    await Promise.all(
      targets.map(async (addr) => {
        const stub = this.env.INBOX.get(this.env.INBOX.idFromName(addr)) as unknown as AgentInbox;
        const r = await stub.deliver(env);
        if (!r.duplicate) delivered++;
      }),
    );
    return { ok: true, delivered };
  }

  // Queue: plaintext work items with lease, ack, nack, dead letter.

  private expireLeases(now = Date.now()) {
    const stale = this.ctx.storage.sql.exec("SELECT id, attempts FROM items WHERE state = 'leased' AND lease_until < ?", now).toArray();
    for (const r of stale) {
      const dead = Number(r.attempts) >= MAX_ATTEMPTS;
      this.ctx.storage.sql.exec("UPDATE items SET state = ?, leased_by = NULL, lease_until = 0 WHERE id = ?", dead ? "dead" : "ready", r.id);
    }
  }

  private async scheduleAlarm() {
    const rows = this.ctx.storage.sql.exec("SELECT MIN(lease_until) AS t FROM items WHERE state = 'leased'").toArray();
    const t = rows.length && rows[0].t != null ? Number(rows[0].t) : 0;
    if (t > 0) await this.ctx.storage.setAlarm(t + 50);
  }

  async alarm() {
    this.expireLeases();
    await this.scheduleAlarm();
  }

  async push(caller: string, id: string, payload: unknown): Promise<{ ok: boolean; status: number }> {
    if (!this.meta("id")) return { ok: false, status: 404 };
    if (!this.isMember(caller)) return { ok: false, status: 403 };
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO items(id, payload, state, created) VALUES (?, ?, 'ready', ?)", id, JSON.stringify(payload), Date.now());
    return { ok: true, status: 201 };
  }

  /** Oldest ready item, leased to the caller. null when the queue is empty. */
  async lease(caller: string, timeoutS: number): Promise<{ status: number; item?: QueueItem }> {
    if (!this.meta("id")) return { status: 404 };
    if (!this.isMember(caller)) return { status: 403 };
    const now = Date.now();
    this.expireLeases(now);
    const rows = this.ctx.storage.sql.exec("SELECT id, payload, attempts, created FROM items WHERE state = 'ready' ORDER BY created LIMIT 1").toArray();
    if (!rows.length) return { status: 204 };
    const r = rows[0];
    const timeout = Math.min(Math.max(Math.floor(timeoutS) || 30, 1), 3600);
    const until = now + timeout * 1000;
    const attempts = Number(r.attempts) + 1;
    this.ctx.storage.sql.exec("UPDATE items SET state = 'leased', leased_by = ?, lease_until = ?, attempts = ? WHERE id = ?", caller, until, attempts, r.id);
    await this.scheduleAlarm();
    return { status: 200, item: { id: String(r.id), payload: JSON.parse(String(r.payload)), attempts, lease_until: until, created: Number(r.created) } };
  }

  /** 200 when the caller holds a live lease on the item; 409 otherwise. */
  async ack(caller: string, id: string): Promise<number> {
    if (!this.meta("id")) return 404;
    if (!this.isMember(caller)) return 403;
    this.expireLeases();
    const rows = this.ctx.storage.sql.exec("SELECT state, leased_by FROM items WHERE id = ?", id).toArray();
    if (!rows.length) return 404;
    if (rows[0].state !== "leased" || rows[0].leased_by !== caller) return 409;
    this.ctx.storage.sql.exec("UPDATE items SET state = 'done', done_at = ?, leased_by = NULL, lease_until = 0 WHERE id = ?", Date.now(), id);
    return 200;
  }

  async nack(caller: string, id: string): Promise<number> {
    if (!this.meta("id")) return 404;
    if (!this.isMember(caller)) return 403;
    this.expireLeases();
    const rows = this.ctx.storage.sql.exec("SELECT state, leased_by, attempts FROM items WHERE id = ?", id).toArray();
    if (!rows.length) return 404;
    if (rows[0].state !== "leased" || rows[0].leased_by !== caller) return 409;
    const dead = Number(rows[0].attempts) >= MAX_ATTEMPTS;
    this.ctx.storage.sql.exec("UPDATE items SET state = ?, leased_by = NULL, lease_until = 0 WHERE id = ?", dead ? "dead" : "ready", id);
    return 200;
  }

  async queueStats(caller: string): Promise<QueueStats | null> {
    if (!this.meta("id") || !this.isMember(caller)) return null;
    this.expireLeases();
    const out: QueueStats = { ready: 0, leased: 0, done: 0, dead: 0 };
    for (const r of this.ctx.storage.sql.exec("SELECT state, COUNT(*) AS n FROM items GROUP BY state").toArray()) {
      out[String(r.state) as keyof QueueStats] = Number(r.n);
    }
    return out;
  }

  async dead(caller: string): Promise<QueueItem[] | null> {
    if (!this.meta("id") || !this.isMember(caller)) return null;
    this.expireLeases();
    return this.ctx.storage.sql
      .exec("SELECT id, payload, attempts, created FROM items WHERE state = 'dead' ORDER BY created")
      .toArray()
      .map((r) => ({ id: String(r.id), payload: JSON.parse(String(r.payload)), attempts: Number(r.attempts), lease_until: 0, created: Number(r.created) }));
  }
}
