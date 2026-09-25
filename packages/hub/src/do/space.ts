/** Space DO: membership, epoch, encrypted board, topic fan-out, queue. Filled in by later tasks. */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class Space extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }
}
