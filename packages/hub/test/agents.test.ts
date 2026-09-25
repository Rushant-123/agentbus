import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, canonical, generate, pubToJson, sign, signedHeaders, toB64 } from "@agentbus/sdk";

const HUB = "http://hub.test";

export async function register(keys = generate()) {
  const pub = pubToJson(keys.pub);
  const sig = toB64(sign(keys, new TextEncoder().encode(canonical(pub))));
  const res = await SELF.fetch(`${HUB}/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...pub, sig }),
  });
  return { keys, res };
}

describe("agents", () => {
  it("registers and returns the SDK-computed address", async () => {
    const { keys, res } = await register();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { address: string };
    expect(body.address).toBe(address(keys.pub));
  });

  it("is idempotent for the same identity", async () => {
    const keys = generate();
    const a = await register(keys);
    const b = await register(keys);
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(200);
  });

  it("rejects a registration whose signature does not match the keys", async () => {
    const keys = generate();
    const other = generate();
    const pub = pubToJson(keys.pub);
    const sig = toB64(sign(other, new TextEncoder().encode(canonical(pub))));
    const res = await SELF.fetch(`${HUB}/v1/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...pub, sig }) });
    expect(res.status).toBe(401);
  });

  it("returns a registered public identity and 404 for unknown", async () => {
    const { keys } = await register();
    const ok = await SELF.fetch(`${HUB}/v1/agents/${address(keys.pub)}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { address: string; verify_key: string; box_key: string };
    expect(body.verify_key).toBe(pubToJson(keys.pub).verify_key);
    const missing = await SELF.fetch(`${HUB}/v1/agents/ab:${"0".repeat(32)}`);
    expect(missing.status).toBe(404);
    const malformed = await SELF.fetch(`${HUB}/v1/agents/not-an-address`);
    expect(malformed.status).toBe(400);
  });

  it("signed GET /v1/whoami works, and fails with a stale timestamp or unknown key", async () => {
    const { keys } = await register();
    const good = await SELF.fetch(`${HUB}/v1/whoami`, { headers: signedHeaders(keys, "GET", "/v1/whoami") });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { address: string }).address).toBe(address(keys.pub));
    const stale = await SELF.fetch(`${HUB}/v1/whoami`, { headers: signedHeaders(keys, "GET", "/v1/whoami", Date.now() - 10 * 60 * 1000) });
    expect(stale.status).toBe(401);
    const unknown = await SELF.fetch(`${HUB}/v1/whoami`, { headers: signedHeaders(generate(), "GET", "/v1/whoami") });
    expect(unknown.status).toBe(401);
  });
});
