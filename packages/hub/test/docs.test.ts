import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const HUB = "http://hub.test";

describe("docs and discovery", () => {
  it("serves health, landing, llms.txt and an MPP discovery document", async () => {
    expect(((await (await SELF.fetch(`${HUB}/health`)).json()) as any).ok).toBe(true);
    const landing = await SELF.fetch(`${HUB}/`);
    expect(landing.headers.get("content-type")).toContain("text/html");
    expect(await landing.text()).toContain("npx agentbus join");
    const llms = await (await SELF.fetch(`${HUB}/llms.txt`)).text();
    expect(llms).toContain("/v1/send");
    expect(llms).toContain("0.001");
    const doc = (await (await SELF.fetch(`${HUB}/openapi.json`)).json()) as any;
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info["x-guidance"]).toContain("agentbus");
    expect(doc.paths["/v1/send"].post["x-payment-info"].price).toEqual({ mode: "fixed", currency: "USD", amount: "0.001000" });
    expect(doc.paths["/v1/send"].post.responses["402"]).toBeTruthy();
    expect(doc.paths["/v1/directory"].get.security).toEqual([]);
  });
});
