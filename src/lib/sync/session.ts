// Session state machine for device-to-device sync (設定 > 同期) — a
// module-level singleton store the UI subscribes to, same pattern as the
// domain modules' subscribe* (lib/storage.ts), but no localStorage/CustomEvent
// involved: this is purely in-memory session state, reset on page reload.
//
// Sequence (symmetric — both host and guest run the same exchange logic):
//   1. startHostSync() / joinGuestSync(roomId) joins a mist room via the
//      shared MistNode (lib/network.ts) and broadcasts `lingo_sync_hello`.
//   2. Every peer that receives a hello (or connects while we're already in
//      the room) gets our current SyncSnapshot (lib/sync/snapshot.ts) sent
//      back as chunked `lingo_sync_data` messages (see lib/sync/protocol.ts's
//      ChunkAssembler for the receive side).
//   3. Once a peer's chunks are fully reassembled, we decode + JSON.parse +
//      mergeSyncSnapshot() them. Success replies `lingo_sync_done` and moves
//      the local phase to "done" (accumulating the merge summary); failure
//      replies `lingo_sync_error` and moves to phase "error" (tearing the
//      session down — see lib/sync/types.ts's SyncPhase doc).
// Both sides send their own snapshot independently of receiving the other's,
// so no designated "master" and no re-send-after-merge is needed: the merge
// itself is a commutative/associative/idempotent CRDT (lib/sync/types.ts),
// so a peer merging our pre-merge snapshot still converges.
import { chunkBase64, randomId } from "@tik-choco/mistai";
import { createMistNode, NODE_ID_STORAGE_KEY } from "../network";
import { mergeSyncSnapshot, buildSyncSnapshot } from "./snapshot";
import { ChunkAssembler, type SyncDataMsg, type SyncMessage } from "./protocol";
import { SyncNetwork } from "./network";
import type { SyncMergeSummary, SyncSessionState, SyncStoreName } from "./types";

// Base64 chars per wire message — mirrors lib/p2p/tunnel.ts's OAI_CHUNK_SIZE
// (mist's reliable data channel is only safe for ~16KB per message).
const SYNC_CHUNK_SIZE = 12 * 1024;
// A guest that hasn't completed any exchange within this window gives up —
// covers both a host that never appears and a host that's stuck/unreachable.
const GUEST_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// UTF-8 <-> base64 helpers. Copied (not imported) from lib/p2p/tunnel.ts:
// that module is an app-level protocol extension for the oai tunnel and
// deliberately not a shared utility home; duplicating a dozen lines here
// keeps lib/sync/ standalone the same way lib/sync/protocol.ts and
// lib/sync/network.ts are standalone forks rather than extensions.

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

// ---------------------------------------------------------------------------
// Session store.

function idleState(): SyncSessionState {
  return {
    phase: "idle",
    role: null,
    roomId: null,
    pendingJoinRoomId: null,
    peerCount: 0,
    error: null,
    summary: null,
  };
}

let state: SyncSessionState = idleState();
const listeners = new Set<() => void>();

let network: SyncNetwork | null = null;
let guestTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
// Reassembly buffers, keyed by `${fromId}:${messageId}`.
const buffers = new Map<string, ChunkAssembler>();
// Peer ids with an in-progress (incomplete) reassembly — drives the
// "waiting"/"done" <-> "exchanging" transition and tells onPeerDisconnected
// whether a disconnect interrupted a transfer in flight.
const pendingPeers = new Set<string>();
// Peer ids we've already sent our snapshot to this session (dedupes re-hellos
// from the same peer; a fresh peer id — e.g. a different guest — always
// gets its own send).
const sentTo = new Set<string>();

function notify(): void {
  for (const cb of [...listeners]) cb();
}

function setState(patch: Partial<SyncSessionState>): void {
  state = { ...state, ...patch };
  notify();
}

export function getSyncState(): SyncSessionState {
  return state;
}

/** Subscribes to session state changes. Returns an unsubscribe function. */
export function subscribeSync(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Tears down the network/timers/buffers but leaves `state` (phase/error/summary) as the caller set it. */
function teardownTransport(): void {
  network?.destroy();
  network = null;
  if (guestTimeoutTimer !== null) {
    clearTimeout(guestTimeoutTimer);
    guestTimeoutTimer = null;
  }
  buffers.clear();
  pendingPeers.clear();
  sentTo.clear();
}

function clearGuestTimeout(): void {
  if (guestTimeoutTimer !== null) {
    clearTimeout(guestTimeoutTimer);
    guestTimeoutTimer = null;
  }
}

/** Ends the active/pending session (if any) and resets to idle. Safe to call any time. */
export function stopSync(): void {
  teardownTransport();
  state = idleState();
  notify();
}

/** Deep-link intake: records a `#/sync/<roomId>` link for the UI to confirm. Does not join. */
export function requestSyncJoin(roomId: string): void {
  setState({ pendingJoinRoomId: roomId });
}

export function clearPendingSyncJoin(): void {
  setState({ pendingJoinRoomId: null });
}

export function syncUrlFor(roomId: string): string {
  return `${location.origin}${location.pathname}${location.search}#/sync/${roomId}`;
}

function beginSession(roomId: string): void {
  const net = new SyncNetwork({
    createNode: createMistNode,
    nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    callbacks: {
      onPeerConnected: handlePeerConnected,
      onPeerDisconnected: handlePeerDisconnected,
      onMessage: handleMessage,
    },
  });
  network = net;
  net
    .join(roomId)
    .then(() => {
      if (network !== net) return; // superseded by a later stopSync()/start*Sync()
      setState({ phase: "waiting" });
      net.send(null, { v: 1, type: "lingo_sync_hello" });
    })
    .catch(() => {
      if (network !== net) return;
      setState({ phase: "error", error: "settings-sync-error-connect" });
      teardownTransport();
    });
}

/** Starts hosting a new session: joins a fresh random room and waits for guests. No waiting timeout — the host stays open until stopSync() so multiple guests can sync in turn. */
export function startHostSync(): void {
  stopSync();
  const roomId = `lingo-sync-${randomId()}`;
  setState({ phase: "connecting", role: "host", roomId });
  beginSession(roomId);
}

/** Joins an existing host's room. Gives up with a timeout error if no exchange completes within {@link GUEST_TIMEOUT_MS}. */
export function joinGuestSync(roomId: string): void {
  stopSync();
  setState({ phase: "connecting", role: "guest", roomId });
  beginSession(roomId);
  guestTimeoutTimer = setTimeout(() => {
    guestTimeoutTimer = null;
    setState({ phase: "error", error: "settings-sync-error-timeout" });
    teardownTransport();
  }, GUEST_TIMEOUT_MS);
}

function handlePeerConnected(peerId: string): void {
  setState({ peerCount: state.peerCount + 1 });
  // The broadcast hello sent on join may predate this peer's arrival, so
  // re-announce directly to them (symmetric: host and guest both do this).
  network?.send(peerId, { v: 1, type: "lingo_sync_hello" });
}

function handlePeerDisconnected(peerId: string): void {
  for (const key of [...buffers.keys()]) {
    if (key.startsWith(`${peerId}:`)) buffers.delete(key);
  }
  sentTo.delete(peerId);
  const wasExchanging = pendingPeers.delete(peerId);
  const nextPeerCount = Math.max(0, state.peerCount - 1);
  if (wasExchanging) {
    setState({ peerCount: nextPeerCount, phase: "error", error: "settings-sync-error-peer-left" });
    teardownTransport();
    return;
  }
  setState({ peerCount: nextPeerCount });
}

function handleMessage(fromId: string, msg: SyncMessage): void {
  switch (msg.type) {
    case "lingo_sync_hello":
      handleHello(fromId);
      return;
    case "lingo_sync_data":
      handleData(fromId, msg);
      return;
    case "lingo_sync_done":
      // Informational only (confirms the peer merged the snapshot we sent
      // them) — merging is a CRDT, so there's nothing to re-send or reconcile.
      return;
    case "lingo_sync_error":
      // The peer rejected the snapshot we sent it — treat the same as us
      // failing to validate theirs; there's no separate contract key for
      // "our data was rejected remotely" (see lib/sync/types.ts's SyncPhase).
      setState({ phase: "error", error: "settings-sync-error-data" });
      teardownTransport();
      return;
  }
}

function handleHello(fromId: string): void {
  if (sentTo.has(fromId)) return;
  sentTo.add(fromId);
  sendSnapshotTo(fromId);
}

function sendSnapshotTo(peerId: string): void {
  if (!network) return;
  const id = randomId();
  const json = JSON.stringify(buildSyncSnapshot());
  const base64 = utf8ToBase64(json);
  const parts = chunkBase64(base64, SYNC_CHUNK_SIZE);
  parts.forEach((data, index) => {
    const last = index === parts.length - 1;
    const msg: SyncDataMsg = { v: 1, type: "lingo_sync_data", id, seq: index, last, data };
    network?.send(peerId, msg);
  });
}

function accumulateSummary(prev: SyncMergeSummary | null, next: SyncMergeSummary): SyncMergeSummary {
  if (!prev) return next;
  const merged = {} as SyncMergeSummary;
  for (const store of Object.keys(next) as SyncStoreName[]) {
    merged[store] = {
      added: prev[store].added + next[store].added,
      updated: prev[store].updated + next[store].updated,
      removed: prev[store].removed + next[store].removed,
    };
  }
  return merged;
}

function failIncomingData(fromId: string, message: string): void {
  network?.send(fromId, { v: 1, type: "lingo_sync_error", message });
  setState({ phase: "error", error: "settings-sync-error-data" });
  teardownTransport();
}

function handleData(fromId: string, msg: SyncDataMsg): void {
  const key = `${fromId}:${msg.id}`;
  let assembler = buffers.get(key);
  if (!assembler) {
    assembler = new ChunkAssembler();
    buffers.set(key, assembler);
  }

  const result = assembler.add(msg.seq, msg.data, msg.last);
  if (result === "too-large") {
    buffers.delete(key);
    pendingPeers.delete(fromId);
    failIncomingData(fromId, "Snapshot exceeded the maximum allowed size.");
    return;
  }
  if (result === "added") {
    pendingPeers.add(fromId);
    if (state.phase === "waiting" || state.phase === "done") setState({ phase: "exchanging" });
  }
  if (!assembler.isComplete) return;

  buffers.delete(key);
  pendingPeers.delete(fromId);

  const base64 = assembler.assemble();
  let parsed: unknown = null;
  let parseOk = false;
  if (base64 !== null) {
    try {
      parsed = JSON.parse(base64ToUtf8(base64));
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }

  const merged = parseOk ? mergeSyncSnapshot(parsed) : null;
  if (merged === null) {
    failIncomingData(fromId, "Remote snapshot failed validation.");
    return;
  }

  setState({ phase: "done", summary: accumulateSummary(state.summary, merged) });
  network?.send(fromId, { v: 1, type: "lingo_sync_done", id: msg.id });
  // (a) local merge succeeded — the guest no longer needs its give-up timer,
  // regardless of whether the peer's own lingo_sync_done for our snapshot
  // has arrived yet (see lib/sync/types.ts's SyncPhase "done" doc).
  clearGuestTimeout();
}
