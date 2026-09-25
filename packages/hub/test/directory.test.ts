import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, signedHeaders, type Keys } from "agentbus-sdk";
import { register } from "./agents.test";

const HUB = "http://hub.test";

async function setProfile(keys: Keys, profile: unknown) {
  const path = "/v1/agents/me/profile";
  const res = await SELF.fetch(`${HUB}${path}`, { method: "PUT", headers: { ...signedHeaders(keys, "PUT", path), "content-type": "application/json" }, body: JSON.stringify(profile) });
  return { status: res.status, body: (await res.json()) as any };
}

async function search(qs: string) {
  const res = await SELF.fetch(`${HUB}/v1/directory?${qs}`);
  return (await res.json()) as { entries: { address: string; profile: any }[] };
}

describe("directory", () => {
  it("only listed profiles appear; search by name, about, kind and capability", async () => {
    const { keys: a } = await register();
    const { keys: b } = await register();
    const { keys: c } = await register();
    const tag = Math.random().toString(36).slice(2, 8);
    expect((await setProfile(a, { name: `citecheck-${tag}`, about: "verifies citations", kind: "service", capabilities: ["citations", "Verify"], listed: true, price: "$0.02/req" })).status).toBe(200);
    expect((await setProfile(b, { name: `pgvector-box-${tag}`, kind: "box", capabilities: ["sql", "vector"], listed: true })).status).toBe(200);
    expect((await setProfile(c, { name: `private-${tag}`, kind: "agent", capabilities: ["citations"], listed: false })).status).toBe(200);

    const byName = await search(`q=citecheck-${tag}`);
    expect(byName.entries.map((e) => e.address)).toEqual([address(a.pub)]);
    expect(byName.entries[0].profile.capabilities).toEqual(["citations", "verify"]);
    const byAbout = await search(`q=verifies`);
    expect(byAbout.entries.some((e) => e.address === address(a.pub))).toBe(true);
    const byKind = await search(`q=${tag}&kind=box`);
    expect(byKind.entries.map((e) => e.address)).toEqual([address(b.pub)]);
    const byCap = await search(`q=${tag}&capability=citations`);
    expect(byCap.entries.map((e) => e.address)).toEqual([address(a.pub)]); // c is unlisted
    expect((await SELF.fetch(`${HUB}/v1/directory?kind=robot`)).status).toBe(400);
    // profile also visible on the public agent record
    const rec = (await (await SELF.fetch(`${HUB}/v1/agents/${address(a.pub)}`)).json()) as any;
    expect(rec.profile.name).toBe(`citecheck-${tag}`);
  });

  it("rejects a profile without a name and requires a signed request", async () => {
    const { keys: a } = await register();
    expect((await setProfile(a, { kind: "agent" })).status).toBe(400);
    const res = await SELF.fetch(`${HUB}/v1/agents/me/profile`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(401);
  });
});
