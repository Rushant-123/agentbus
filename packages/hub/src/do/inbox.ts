/** AgentInbox DO: one per agent address. Ordered, deduplicated message log with WebSocket push (hibernation API). */
import { DurableObject } from "cloudflare:workers";
import type { Envelope } from "agentbus-sdk";
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

  /** Persist once per envelope id, then push to every open socket. Returns the seq the id has. */
  async deliver(env: Envelope): Promise<Delivered> {
    const existing = this.ctx.storage.sql.exec("SELECT seq FROM messages WHERE id = ?", env.id).toArray();
    if (existing.length) return { seq: Number(existing[0].seq), duplicate: true };
    this.ctx.storage.sql.exec("INSERT INTO messages(id, envelope, ts) VALUES (?, ?, ?)", env.id, JSON.stringify(env), Date.now());
    const seq = Number(this.ctx.storage.sql.exec("SELECT seq FROM messages WHERE id = ?", env.id).one().seq);
    const frame = JSON.stringify({ seq, envelope: env });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // socket already gone; hibernation API drops it
      }
    }
    return { seq, duplicate: false };
  }

  async list(since: number, limit: number): Promise<InboxPage> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rows = this.ctx.storage.sql.exec("SELECT seq, envelope FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", since, lim).toArray();
    const messages = rows.map((r) => ({ seq: Number(r.seq), envelope: JSON.parse(String(r.envelope)) as Envelope }));
    const next = messages.length ? messages[messages.length - 1].seq : since;
    return { messages, next };
  }

  /** WebSocket upgrade. The Worker has already authenticated the caller. `since` replays missed messages first. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const replay = await this.list(Number.isFinite(since) ? since : 0, 200);
    for (const m of replay.messages) pair[1].send(JSON.stringify(m));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
