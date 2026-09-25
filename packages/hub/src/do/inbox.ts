/** AgentInbox DO: one per agent address. Ordered message log, later WebSocket push. */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class AgentInbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, envelope TEXT NOT NULL, ts INTEGER NOT NULL)`);
    });
  }
}
