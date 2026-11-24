import { beforeAll, expect, it } from "vitest";
import { createDidIdentity, signDelegation } from "@tik-choco/mistai/identity";
import type { DidIdentity, DelegationV1 } from "@tik-choco/mistai/identity";
import { deriveSessionKey, didRoomId, newChallenge, seal, signAuth, unseal, verifyAuth } from "../src/lib/sync/didProtocol";
import type { Auth } from "../src/lib/sync/didProtocol";
import { parseHash } from "../src/lib/hashRoute";

let root: DidIdentity, leaf: DidIdentity, other: DidIdentity;
let delegation: DelegationV1, proof: Auth;
let a: Awaited<ReturnType<typeof newChallenge>>, b: typeof a;
beforeAll(async () => {
  [root, leaf, other] = await Promise.all([createDidIdentity(), createDidIdentity(), createDidIdentity()]);
  delegation = await signDelegation(root, leaf.did);
  [a, b] = await Promise.all([newChallenge(leaf.did), newChallenge(other.did)]);
  proof = await signAuth(leaf, delegation, a.hello, b.hello);
});

it("derives the root room from the specified UTF-8 SHA-256 prefix and reserves it from QR invitations", async () => {
  const room = await didRoomId("did:key:example");
  expect(room).toBe("lingo-did-sync-89a5e7a29ad8593a7f990546c56e73ad");
  expect(await didRoomId("did:key:example")).toBe(room);
  expect(await didRoomId(root.did)).not.toBe(await didRoomId(other.did));
  expect(parseHash("#/sync/" + room).syncRoomId).toBeUndefined();
  expect(parseHash("#/sync/lingo-sync-123").syncRoomId).toBe("lingo-sync-123");
});

it("verifies the leaf and its root and derives a key that both sides can use", async () => {
  expect(await verifyAuth(proof, b.hello, a.hello, root.did)).toBe(true);
  const sender = await deriveSessionKey(a.privateKey, a.hello, b.hello);
  const receiver = await deriveSessionKey(b.privateKey, b.hello, a.hello);
  const message = { v: 1, type: "lingo_sync_hello" } as const;
  const wire = await seal(sender, a.hello.nonce, 1, message);
  expect(await unseal(receiver, a.hello.nonce, wire)).toEqual(message);
  await expect(unseal(receiver, b.hello.nonce, wire)).rejects.toThrow();
  await expect(unseal(receiver, a.hello.nonce, { ...wire, n: 2 })).rejects.toThrow();
});

it("rejects a foreign root, counterfeit root delegation and bad leaf signature", async () => {
  expect(await verifyAuth(proof, b.hello, a.hello, other.did)).toBe(false);
  const forged = await signAuth(leaf, { ...delegation, sig: proof.sig }, a.hello, b.hello);
  expect(await verifyAuth(forged, b.hello, a.hello, root.did)).toBe(false);
  expect(await verifyAuth({ ...proof, sig: delegation.sig }, b.hello, a.hello, root.did)).toBe(false);
});

it("rejects replay across challenges and substitution of either endpoint", async () => {
  const fresh = await newChallenge(other.did);
  expect(await verifyAuth(proof, fresh.hello, a.hello, root.did)).toBe(false);
  for (const changed of [{ nonce: fresh.hello.nonce }, { ephPub: fresh.hello.ephPub }, { leaf: root.did }]) {
    expect(await verifyAuth(proof, { ...b.hello, ...changed }, a.hello, root.did)).toBe(false);
    expect(await verifyAuth(proof, b.hello, { ...a.hello, ...changed }, root.did)).toBe(false);
  }
  const expired = await signDelegation(root, leaf.did, { now: Date.now() - 10_000, ttlMs: 5_000 });
  expect(await verifyAuth(await signAuth(leaf, expired, a.hello, b.hello), b.hello, a.hello, root.did)).toBe(false);
});
