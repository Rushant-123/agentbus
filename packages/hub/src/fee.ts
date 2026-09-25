/** Pure decisions for the stranger fee and rate limits. No I/O, fully unit-testable. */

export type FeeDecision = "free" | "count" | "charge";

export function decide(input: { sharesSpace: boolean; selfSend: boolean; todayCount: number; limit: number }): FeeDecision {
  if (input.selfSend || input.sharesSpace) return "free";
  return input.todayCount < input.limit ? "count" : "charge";
}

/** UTC day key, e.g. "2026-09-25". Allowances reset at 00:00 UTC. */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Minute bucket for sliding-ish rate limits. */
export function minuteKey(now = Date.now()): number {
  return Math.floor(now / 60000);
}

export const STRANGER_FEE_USD = "0.001";

export function limits(env: { STRANGER_FREE_PER_DAY?: string; RATE_INSPACE_PER_MIN?: string; RATE_STRANGER_PER_MIN?: string }) {
  return {
    strangerFreePerDay: Number(env.STRANGER_FREE_PER_DAY ?? 20),
    inSpacePerMin: Number(env.RATE_INSPACE_PER_MIN ?? 600),
    strangerPerMin: Number(env.RATE_STRANGER_PER_MIN ?? 60),
  };
}
