/** Client-side space helpers: group keys, sealed invites, encrypted posts. The hub never sees any of this in clear. */
import { fromB64, groupDecrypt, groupEncrypt, groupKey, openSealed, seal, toB64, type Keys, type PublicIdentity } from "./crypto";
import { build, type Body, type Envelope } from "./envelope";

export type SpaceKey = { space_id: string; name: string; group_key: string; epoch: number }; // group_key base64

export function newSpaceKey(space_id: string, name: string, epoch = 1): SpaceKey {
  return { space_id, name, group_key: toB64(groupKey()), epoch };
}

/** Sealed DM of kind "invite" carrying the space key to the invitee. */
export function makeInvite(keys: Keys, inviteeAddress: string, inviteePub: PublicIdentity, key: SpaceKey): Envelope {
  const sealed = seal(inviteePub, new TextEncoder().encode(JSON.stringify(key)));
  return build(keys, { to: inviteeAddress, kind: "invite", priority: "normal", body: { sealed: toB64(sealed) } });
}

export function openInvite(keys: Keys, env: Envelope): SpaceKey {
  if (env.kind !== "invite" || !("sealed" in env.body)) throw new Error("not an invite");
  const j = JSON.parse(new TextDecoder().decode(openSealed(keys, fromB64(env.body.sealed)))) as SpaceKey;
  if (typeof j.space_id !== "string" || typeof j.group_key !== "string" || typeof j.epoch !== "number") throw new Error("malformed invite");
  return j;
}

export function encryptForSpace(key: SpaceKey, payload: unknown): Body {
  return { group: key.space_id, ct: toB64(groupEncrypt(fromB64(key.group_key), new TextEncoder().encode(JSON.stringify(payload)))) };
}

export function decryptFromSpace(key: SpaceKey, body: Body): unknown {
  if (!("group" in body)) throw new Error("not a group body");
  if (body.group !== key.space_id) throw new Error("body is for another space");
  return JSON.parse(new TextDecoder().decode(groupDecrypt(fromB64(key.group_key), fromB64(body.ct))));
}

/** Build a signed board post addressed to the space. */
export function buildPost(keys: Keys, key: SpaceKey, payload: unknown, kind = "post"): Envelope {
  return build(keys, { to: `space:${key.space_id}`, kind, priority: "normal", body: encryptForSpace(key, payload) });
}
