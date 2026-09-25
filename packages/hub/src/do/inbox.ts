/** AgentInbox DO: one per agent address. Ordered, deduplicated message log. WebSocket push added in Task 5. */
import { DurableObject } from "cloudflare:workers";
import type { Envelope } from "@agentbus/sdk";
import type { Env } from "../env";

export type Delivered = { seq: number; duplicate: boolean };
export type InboxPage = { messages: { seq: number; envelope: Envelope }[]; next: number };

export class AgentInbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, envelope TEXT NOT NULL, ts INTEGER NOT NULL)`);
    });
  }

  /** Persist once per envelope id. Returns the seq the id has (existing on replay). */
  async deliver(env: Envelope): Promise<Delivered> {
    const existing = this.ctx.storage.sql.exec("SELECT seq FROM messages WHERE id = ?", env.id).toArray();
    if (existing.length) return { seq: Number(existing[0].seq), duplicate: true };
    this.ctx.storage.sql.exec("INSERT INTO messages(id, envelope, ts) VALUES (?, ?, ?)", env.id, JSON.stringify(env), Date.now());
    const seq = Number(this.ctx.storage.sql.exec("SELECT seq FROM messages WHERE id = ?", env.id).one().seq);
    return { seq, duplicate: false };
  }

  async list(since: number, limit: number): Promise<InboxPage> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rows = this.ctx.storage.sql.exec("SELECT seq, envelope FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", since, lim).toArray();
    const messages = rows.map((r) => ({ seq: Number(r.seq), envelope: JSON.parse(String(r.envelope)) as Envelope }));
    const next = messages.length ? messages[messages.length - 1].seq : since;
    return { messages, next };
  }
}
