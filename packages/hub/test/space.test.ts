import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { address, buildPost, decryptFromSpace, makeInvite, newSpaceKey, openInvite, signedHeaders, type Envelope, type Keys } from "@agentbus/sdk";
import { register } from "./agents.test";

const HUB = "http://hub.test";

async function signedJson(keys: Keys, method: string, path: string, body?: unknown) {
  const pathname = path.split("?")[0];
  const res = await SELF.fetch(`${HUB}${path}`, { method, headers: { ...signedHeaders(keys, method, pathname), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function postBoard(id: string, env: Envelope) {
  const res = await SELF.fetch(`${HUB}/v1/spaces/${id}/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
  return { status: res.status, body: (await res.json()) as any };
}

describe("spaces", () => {
  it("owner creates a space, invites a member over a sealed DM, member posts encrypted, hub stores ciphertext", async () => {
    const { keys: owner } = await register();
    const { keys: member } = await register();
    const { keys: outsider } = await register();

    const created = await signedJson(owner, "POST", "/v1/spaces", { name: "caspian" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const key = newSpaceKey(id, "caspian", created.body.epoch);

    // outsider cannot see it
    expect((await signedJson(outsider, "GET", `/v1/spaces/${id}`)).status).toBe(403);

    // add member (owner only)
    expect((await signedJson(member, "POST", `/v1/spaces/${id}/members`, { address: address(outsider.pub) })).status).toBe(403);
    const added = await signedJson(owner, "POST", `/v1/spaces/${id}/members`, { address: address(member.pub) });
    expect(added.status).toBe(200);
    expect(added.body.epoch).toBe(1);

    // invite carries the key, sealed, over a normal DM
    const inv = makeInvite(owner, address(member.pub), member.pub, key);
    const sent = await SELF.fetch(`${HUB}/v1/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inv) });
    expect(sent.status).toBe(202);
    const inboxRes = await SELF.fetch(`${HUB}/v1/inbox?since=0`, { headers: signedHeaders(member, "GET", "/v1/inbox") });
    const inbox = (await inboxRes.json()) as { messages: { envelope: Envelope }[] };
    const received = openInvite(member, inbox.messages[0].envelope);
    expect(received.group_key).toBe(key.group_key);

    // member posts; outsider cannot; plaintext never reaches the hub
    const post = buildPost(member, received, { text: "standup at 9" });
    const ok = await postBoard(id, post);
    expect(ok.status).toBe(202);
    expect(ok.body.seq).toBe(1);
    const bad = await postBoard(id, buildPost(outsider, key, { text: "intruder" }));
    expect(bad.status).toBe(403);

    const page = await signedJson(owner, "GET", `/v1/spaces/${id}/board?since=0`);
    expect(page.status).toBe(200);
    expect(page.body.posts).toHaveLength(1);
    expect(JSON.stringify(page.body)).not.toContain("standup");
    expect(page.body.posts[0].epoch).toBe(1);
    expect(decryptFromSpace(key, page.body.posts[0].envelope.body)).toEqual({ text: "standup at 9" });

    // replayed post is stored once
    const again = await postBoard(id, post);
    expect(again.status).toBe(202);
    expect(again.body.seq).toBe(1);
  });

  it("removing a member bumps the epoch and blocks their later posts", async () => {
    const { keys: owner } = await register();
    const { keys: member } = await register();
    const created = await signedJson(owner, "POST", "/v1/spaces", { name: "t" });
    const id = created.body.id as string;
    const key = newSpaceKey(id, "t");
    await signedJson(owner, "POST", `/v1/spaces/${id}/members`, { address: address(member.pub) });
    expect((await postBoard(id, buildPost(member, key, 1))).status).toBe(202);
    const removed = await signedJson(owner, "DELETE", `/v1/spaces/${id}/members/${address(member.pub)}`);
    expect(removed.status).toBe(200);
    expect(removed.body.epoch).toBe(2);
    expect((await postBoard(id, buildPost(member, key, 2))).status).toBe(403);
    const info = await signedJson(owner, "GET", `/v1/spaces/${id}`);
    expect(info.body.epoch).toBe(2);
    expect(info.body.members).toEqual([address(owner.pub)]);
    expect((await signedJson(owner, "DELETE", `/v1/spaces/${id}/members/${address(owner.pub)}`)).status).toBe(400);
  });

  it("rejects a post whose body is not group-encrypted for that space", async () => {
    const { keys: owner } = await register();
    const created = await signedJson(owner, "POST", "/v1/spaces", { name: "t" });
    const id = created.body.id as string;
    const wrongSpace = buildPost(owner, newSpaceKey("01ARZ3NDEKTSV4RRFFQ69G5FAV", "x"), 1);
    const res = await SELF.fetch(`${HUB}/v1/spaces/${id}/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...wrongSpace, to: `space:${id}` }) });
    expect(res.status).toBe(401); // re-addressed envelope no longer verifies
    const plain = { ...buildPost(owner, newSpaceKey(id, "t"), 1) };
    const forgedPlain = await SELF.fetch(`${HUB}/v1/spaces/${id}/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...plain, body: { plain: "leak" } }) });
    expect(forgedPlain.status).toBe(401);
  });
});
