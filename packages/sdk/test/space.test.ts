import { describe, expect, it } from "vitest";
import { address, generate, verifyEnvelope } from "../src";
import { buildPost, decryptFromSpace, encryptForSpace, makeInvite, newSpaceKey, openInvite } from "../src/space";

describe("space helpers", () => {
  const owner = generate();
  const member = generate();
  const outsider = generate();
  const key = newSpaceKey("01SPACE", "caspian");

  it("invite is a sealed DM only the invitee can open", () => {
    const inv = makeInvite(owner, address(member.pub), member.pub, key);
    expect(inv.kind).toBe("invite");
    expect(verifyEnvelope(inv, owner.pub)).toBe(true);
    expect(openInvite(member, inv)).toEqual(key);
    expect(() => openInvite(outsider, inv)).toThrow();
  });

  it("posts are group-encrypted and readable by anyone holding the key", () => {
    const post = buildPost(member, key, { text: "standup at 9" });
    expect(post.to).toBe("space:01SPACE");
    expect("group" in post.body && post.body.group).toBe("01SPACE");
    expect(JSON.stringify(post.body)).not.toContain("standup");
    expect(decryptFromSpace(key, post.body)).toEqual({ text: "standup at 9" });
    const other = newSpaceKey("01SPACE", "caspian", 2);
    expect(() => decryptFromSpace(other, post.body)).toThrow();
    expect(() => decryptFromSpace(newSpaceKey("02OTHER", "x"), encryptForSpace(key, 1))).toThrow(/another space/);
  });
});
