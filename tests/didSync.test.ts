import {
  chunkBase64, createSharedNodeScope, EVENT_PEER_CONNECTED, EVENT_RAW, utf8ToBase64,
} from "@tik-choco/mistai";
import type { MistNodeLike } from "@tik-choco/mistai";
import {
  computePairingMac, createDidIdentity, pairingMacKey, saveDelegation, SHARED_DELEGATION_KEY, signDelegation,
} from "@tik-choco/mistai/identity";
import type { DidIdentity } from "@tik-choco/mistai/identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDidIdentity, invalidateDidIdentity, SHARED_IDENTITY_CID } from "../src/lib/did/identity";
import { getDidLink, pairDidDelegation } from "../src/lib/did/pairing";
import { loadSettings, saveSettings } from "../src/lib/settings";
import { saveJson } from "../src/lib/storage";
import { deriveSessionKey, didRoomId, newChallenge, seal, signAuth, unseal, verifyAuth } from "../src/lib/sync/didProtocol";
import { getDidSyncState, startDidSync, syncDidNow } from "../src/lib/sync/didSync";
import { getSyncState, startHostSync, stopSync } from "../src/lib/sync/session";
import { buildSyncSnapshot } from "../src/lib/sync/snapshot";

const mocks = vi.hoisted(() => ({ node: vi.fn(), get: vi.fn(), add: vi.fn() }));
vi.mock("../src/lib/network", () => ({
  NODE_ID_STORAGE_KEY: "test-node", createAppNode: () => mocks.node("self"), createMistNode: mocks.node,
}));
vi.mock("../src/lib/mistStorage", () => ({ storageGetText: mocks.get, storageAddJson: mocks.add }));

let root: DidIdentity, local: DidIdentity, remote: DidIdentity;
let stop: (() => void) | undefined;
let event: Parameters<MistNodeLike["onEvent"]>[0];
const packets: { to: string | null | undefined; room?: string; msg: ReturnType<typeof JSON.parse> }[] = [];
const join = vi.fn();
const leave = vi.fn();
function emit(room: string, msg: unknown, id = "remote") {
  event(EVENT_RAW, id, new TextEncoder().encode(JSON.stringify(msg)), room);
}
function changedKey(key: string) {
  window.dispatchEvent(Object.assign(new Event("storage"), { key }));
}
async function until(check: () => void) { await vi.waitFor(check, { interval: 5, timeout: 2_000 }); }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  const values = new Map([["test-node", "self"]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  [root, local, remote] = await Promise.all([createDidIdentity(), createDidIdentity(), createDidIdentity()]);
  localStorage.setItem(SHARED_IDENTITY_CID, "cid");
  mocks.get.mockResolvedValue(JSON.stringify(local));
  mocks.node.mockImplementation(createSharedNodeScope(() => ({
    onEvent(handler) { event = handler; }, init: async () => {}, joinRoom: join, leaveRoom: leave,
    sendMessage(to, bytes, _, room) { packets.push({ to, room, msg: JSON.parse(new TextDecoder().decode(bytes)) }); },
  })));
  invalidateDidIdentity();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  stopSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  packets.length = 0;
  vi.resetAllMocks();
});

it("adopts the shared identity, falls back to the mirror and preserves an unreachable CID", async () => {
  const mirror = "tc-lingo-did-identity-v1";
  localStorage.setItem(mirror, JSON.stringify(remote));
  expect(ensureDidIdentity()).toBe(ensureDidIdentity());
  expect((await ensureDidIdentity()).did).toBe(local.did);
  expect(JSON.parse(localStorage.getItem(mirror)!).did).toBe(local.did);
  mocks.get.mockRejectedValue(new Error("Offline"));
  invalidateDidIdentity();
  expect((await ensureDidIdentity()).did).toBe(local.did);
  expect(localStorage.getItem(SHARED_IDENTITY_CID)).toBe("cid");
  localStorage.removeItem(SHARED_IDENTITY_CID);
  mocks.add.mockResolvedValue("new-cid");
  invalidateDidIdentity();
  expect((await ensureDidIdentity()).did).toBe(local.did);
  expect(localStorage.getItem(SHARED_IDENTITY_CID)).toBe("new-cid");
});

it("pairs with a normalized code on the shared node and observes unlink and expiry", async () => {
  stop = startDidSync();
  await until(() => expect(getDidLink().leafDid).toBe(local.did));
  expect(getDidSyncState().status).toBe("no-delegation");
  expect(join).not.toHaveBeenCalled();
  const code = "0123456789ABCDEF";
  const pairing = pairDidDelegation("o123-4567-89ab-cdef");
  await until(() => expect(packets.length).toBe(1));
  const { room, msg } = packets[0];
  expect(msg.app).toBe("tc-lingo");
  expect(msg.leaf).toBe(local.did);
  const delegation = await signDelegation(root, local.did, { ttlMs: 10_000 });
  const response = { v: 1, type: "tc-did-pair:response", nonce: msg.nonce, delegation };
  emit(room!, { ...response, mac: await computePairingMac(response, await pairingMacKey(code)) });
  await pairing;
  await until(() => expect(getDidSyncState().status).toBe("idle"));
  expect(getDidLink().rootDid).toBe(root.did);
  expect(leave).toHaveBeenCalledWith(room);
  const didRoom = await didRoomId(root.did);
  expect(join).toHaveBeenCalledWith(didRoom);
  localStorage.removeItem(SHARED_DELEGATION_KEY);
  changedKey(SHARED_DELEGATION_KEY);
  expect(leave).toHaveBeenCalledWith(didRoom);
  expect(getDidSyncState().status).toBe("no-delegation");
  saveDelegation(delegation);
  changedKey(SHARED_DELEGATION_KEY);
  await until(() => expect(getDidSyncState().status).toBe("idle"));
  await vi.advanceTimersByTimeAsync(11_000);
  expect(getDidLink().rootDid).toBeNull();
  expect(getDidSyncState().status).toBe("no-delegation");
});

it("recovers from a failed room join on the five-minute fallback and releases its handle on unmount", async () => {
  saveDelegation(await signDelegation(root, local.did));
  const room = await didRoomId(root.did);
  join.mockRejectedValueOnce(new Error("Offline"));
  stop = startDidSync();
  await until(() => expect(getDidSyncState().error).toBe("settings-did-connect-error"));
  expect(getDidSyncState().status).toBe("error");
  await vi.advanceTimersByTimeAsync(300_000);
  await until(() => expect(getDidSyncState().status).toBe("idle"));
  expect(join).toHaveBeenCalledTimes(2);
  stop();
  stop = undefined;
  expect(leave).toHaveBeenCalledWith(room);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(join).toHaveBeenCalledTimes(2);
});

it("caps handshakes, discards unconfirmed work on disable and skips the room at the next startup", async () => {
  saveDelegation(await signDelegation(root, local.did));
  stop = startDidSync();
  await until(() => expect(getDidSyncState().status).toBe("idle"));
  const room = await didRoomId(root.did);
  for (let i = 0; i < 40; i++) event(EVENT_PEER_CONNECTED, "peer-" + i, null, room);
  await until(() => expect(packets.filter(p => p.msg.type === "lingo_didsync_hello").length).toBe(16));
  expect(getDidSyncState().peerCount).toBe(0);
  saveSettings({ ...loadSettings(), didAutoSync: false });
  const count = packets.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(packets.length).toBe(count);
  stop();
  stop = startDidSync();
  await until(() => expect(getDidLink().rootDid).toBe(root.did));
  expect(join).toHaveBeenCalledTimes(1);
  expect(getDidSyncState().status).toBe("off");
});

it("requires mutual confirmation, merges encrypted chunks, resyncs and leaves the QR room operational", async () => {
  const room = await didRoomId(root.did);
  saveDelegation(await signDelegation(root, local.did));
  stop = startDidSync();
  await until(() => expect(getDidSyncState().status).toBe("idle"));
  startHostSync();
  await until(() => expect(getSyncState().phase).toBe("waiting"));
  const qr = getSyncState().roomId!;
  event(EVENT_PEER_CONNECTED, "remote", null, room);
  const sent = (type: string) => packets.filter(p => p.room === room && p.msg.type === type);
  await until(() => expect(sent("lingo_didsync_hello").length).toBe(1));
  const localHello = sent("lingo_didsync_hello")[0].msg;
  const challenge = await newChallenge(remote.did);
  emit(room, challenge.hello);
  await until(() => expect(sent("lingo_didsync_auth").length).toBe(1));
  expect(await verifyAuth(sent("lingo_didsync_auth")[0].msg, challenge.hello, localHello, root.did)).toBe(true);
  emit(room, { v: 1, type: "lingo_sync_hello" });
  expect(sent("lingo_didsync_sealed").length).toBe(0);
  emit(room, await signAuth(remote, await signDelegation(root, remote.did), challenge.hello, localHello));
  await until(() => expect(sent("lingo_didsync_sealed").length).toBe(1));
  const key = await deriveSessionKey(challenge.privateKey, challenge.hello, localHello);
  const outgoing = async () => Promise.all(sent("lingo_didsync_sealed").map(p => unseal(key, localHello.nonce, p.msg)));
  expect(await outgoing()).toEqual([{ v: 1, type: "lingo_sync_hello" }]);
  expect(getDidSyncState().peerCount).toBe(0);
  let n = 0;
  const request = await seal(key, challenge.hello.nonce, ++n, { v: 1, type: "lingo_sync_hello" });
  emit(room, request);
  await until(() => expect(getDidSyncState().peerCount).toBe(1));
  await until(() => expect(sent("lingo_didsync_sealed").length).toBe(2));
  const first = (await outgoing()).at(-1)!;
  if (first.type !== "lingo_sync_data") throw new Error("Expected a snapshot");
  const snapshot = buildSyncSnapshot();
  snapshot.tombstones = [{ store: "cards", id: "remote-card", deletedAt: new Date().toISOString() }];
  const parts = chunkBase64(utf8ToBase64(JSON.stringify(snapshot)), 128);
  for (const [seq, data] of parts.entries()) {
    emit(room, await seal(key, challenge.hello.nonce, ++n,
      { v: 1, type: "lingo_sync_data", id: "transfer", seq, data, last: seq === parts.length - 1 }));
  }
  emit(room, await seal(key, challenge.hello.nonce, ++n, { v: 1, type: "lingo_sync_done", id: first.id }));
  await until(() => expect(getDidSyncState().status).toBe("idle"));
  expect(buildSyncSnapshot().tombstones).toEqual(snapshot.tombstones);
  expect(getDidSyncState().lastSyncedAt).toBeTypeOf("number");
  const before = sent("lingo_didsync_sealed").length;
  emit(room, request); // Delayed replay cannot trigger another send.
  saveJson("cards-v1", []);
  await vi.advanceTimersByTimeAsync(6_999);
  expect(sent("lingo_didsync_sealed").length).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => expect(sent("lingo_didsync_sealed").length).toBe(before + 1));
  syncDidNow();
  await until(() => expect(sent("lingo_didsync_sealed").length).toBe(before + 3));
  expect(packets.filter(p => p.room === room).every(p => p.msg.type === "lingo_didsync_discover" ||
    (p.to === "remote" && p.msg.type.startsWith("lingo_didsync_")))).toBe(true);
  expect(getSyncState().debug.helloReceived).toBe(0);
  saveSettings({ ...loadSettings(), didAutoSync: false });
  expect(getDidSyncState().status).toBe("off");
  expect(leave).toHaveBeenCalledWith(room);
  expect(leave).not.toHaveBeenCalledWith(qr);
  emit(qr, { v: 1, type: "lingo_sync_hello" }, "guest");
  expect(packets.some(p => p.room === qr && p.to === "guest" && p.msg.type === "lingo_sync_data")).toBe(true);
});
