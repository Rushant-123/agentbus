/** POST /v1/send and GET /v1/inbox. */
import { Hono } from "hono";
import { isAddress, pubFromJson, sizeOk, verifyEnvelope, type Envelope } from "@agentbus/sdk";
import type { Env } from "../env";
import type { AgentInbox } from "../do/inbox";
import { directory, signedAuth, type Vars } from "../shared";
import { checkSignedHeaders } from "@agentbus/sdk";
import { Mppx, tempo } from "mppx/hono";
import { decide, dayKey, limits, minuteKey, STRANGER_FEE_USD, type FeeDecision } from "../fee";

export const inbox = (env: Env, addr: string) => env.INBOX.get(env.INBOX.idFromName(addr)) as unknown as AgentInbox;

type SendVars = Vars & { envelope?: Envelope; decision?: FeeDecision };

/** Run the MPP charge gate: 402 with a challenge when unpaid, next() when a valid credential is presented. */
async function challenge(c: any, next: () => Promise<void>): Promise<Response | undefined> {
  const testnet = c.env.TESTNET === "true";
  const mppx = Mppx.create({ methods: [tempo.charge({ testnet })], secretKey: c.env.MPP_SECRET_KEY });
  const gate = mppx.charge({
    amount: STRANGER_FEE_USD,
    currency: testnet ? CURRENCY.testnet : CURRENCY.mainnet,
    decimals: 6,
    recipient: c.env.RECIPIENT,
    description: "agentbus: message a stranger (daily free allowance used)",
  });
  const out = await gate(c, next);
  return out instanceof Response ? out : undefined;
}
export const messaging = new Hono<{ Bindings: Env; Variables: SendVars }>();

/** USDC.e on Tempo mainnet; pathUSD on testnet. Same constants as citecheck. */
const CURRENCY = { mainnet: "0x20C000000000000000000000b9537d11c60E8b50", testnet: "0x20c0000000000000000000000000000000000000" } as const;

messaging.post(
  "/v1/send",
  // 1. verify, decide free / count / charge, rate limit; on "charge" run the MPP gate
  async (c, next) => {
    const env = (await c.req.json().catch(() => null)) as Envelope | null;
    const wellFormed = !!env && typeof env === "object" && isAddress(env.from) && isAddress(env.to);
    if (!wellFormed) {
      // Discovery probes post an empty body, with or without a (possibly malformed) credential. Let the MPP gate
      // answer: 402 with the challenge, or 402 for a bad credential. A valid paid retry with no envelope ends in 400 below.
      return challenge(c, next);
    }
    if (!sizeOk(env)) return c.json({ error: "envelope over 64 KB" }, 413);
    const dir = directory(c.env);
    const sender = await dir.get(env.from);
    if (!sender) return c.json({ error: "unknown sender" }, 401);
    if (!verifyEnvelope(env, pubFromJson({ verify_key: sender.verify_key, box_key: sender.box_key }))) return c.json({ error: "bad signature" }, 401);
    const recipient = await dir.get(env.to);
    if (!recipient) return c.json({ error: "unknown recipient" }, 404);
    c.set("envelope", env);

    const lim = limits(c.env);
    const selfSend = env.from === env.to;
    const sharesSpace = selfSend ? true : await dir.sharesSpace(env.from, env.to);
    const decision = decide({ sharesSpace, selfSend, todayCount: sharesSpace ? 0 : await dir.strangerCount(env.from, dayKey()), limit: lim.strangerFreePerDay });
    c.set("decision", decision);

    const lane = decision === "free" ? "inspace" : "stranger";
    const hits = await dir.rateHit(env.from, lane, minuteKey());
    if (hits > (lane === "inspace" ? lim.inSpacePerMin : lim.strangerPerMin)) {
      c.header("retry-after", String(60 - (Math.floor(Date.now() / 1000) % 60)));
      return c.json({ error: `rate limit: ${lane} sends per minute` }, 429);
    }
    if (decision !== "charge") return next();
    return challenge(c, next);
  },
  // 2. deliver
  async (c) => {
    const env = c.get("envelope");
    const decision = c.get("decision");
    if (!env) return c.json({ error: "envelope required: {v, id, from, to, kind, ts, priority, body, sig}" }, 400);
    const { seq } = await inbox(c.env, env.to).deliver(env);
    if (decision === "count") await directory(c.env).bumpStranger(env.from, dayKey());
    return c.json({ id: env.id, seq, lane: decision }, 202);
  },
);

messaging.get("/v1/inbox", signedAuth, async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const limit = Number(c.req.query("limit") ?? 50);
  if (!Number.isFinite(since) || since < 0) return c.json({ error: "since must be a non-negative integer" }, 400);
  const page = await inbox(c.env, c.get("caller")).list(since, Number.isFinite(limit) ? limit : 50);
  return c.json(page);
});

/** WebSocket upgrade. Auth via query (browsers cannot set headers on upgrades): agent, ts, sig over "GET /v1/inbox/ws". */
messaging.get("/v1/inbox/ws", async (c) => {
  const q = c.req.query();
  const agent = q.agent;
  const row = agent && isAddress(agent) ? await directory(c.env).get(agent) : null;
  const pub = row ? pubFromJson({ verify_key: row.verify_key, box_key: row.box_key }) : null;
  const headers = { get: (n: string) => ({ "x-agent": q.agent, "x-ts": q.ts, "x-sig": q.sig } as Record<string, string | undefined>)[n] ?? null };
  const check = checkSignedHeaders(headers, "GET", "/v1/inbox/ws", pub);
  if (!check.ok) return c.json({ error: check.reason }, 401);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket upgrade" }, 426);
  const stub = c.env.INBOX.get(c.env.INBOX.idFromName(check.address));
  return stub.fetch(c.req.raw);
});
