import { DELIVERY_RELIABLE, EVENT_PEER_CONNECTED, EVENT_PEER_DISCONNECTED, EVENT_RAW } from "@tik-choco/mistai";
import type { DelegationV1, DidIdentity } from "@tik-choco/mistai/identity";
import { ensureDidIdentity } from "../did/identity";
import { getDidLink, subscribeDidLink, watchDidLink } from "../did/pairing";
import { createAppNode } from "../network";
import { loadSettings } from "../settings";
import { subscribeStorageChanges } from "../storage";
import { createDidPeer } from "./didPeer";
import { decodeDidMessage, didRoomId } from "./didProtocol";
import type { DidMessage } from "./didProtocol";

interface DidSyncState {
  status: "off" | "no-delegation" | "connecting" | "idle" | "syncing" | "error";
  error: string | null;
  peerCount: number;
  lastSyncedAt: number | null;
}
const initial: DidSyncState = { status: "off", error: null, peerCount: 0, lastSyncedAt: null };
let state = initial;
const listeners = new Set<() => void>();
export const getDidSyncState = () => state;
export function subscribeDidSync(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function update(patch: Partial<DidSyncState>) {
  state = { ...state, ...patch };
  for (const cb of listeners) cb();
}

const syncedStores = new Set(["cards-v1", "topics-v1", "attempts-v1", "passages-v1", "conversations-v1", "levels-v1", "sync-tombstones-v1"]);
type Peer = ReturnType<typeof createDidPeer>;
interface Room {
  node: ReturnType<typeof createAppNode>;
  delegation: DelegationV1;
  peers: Map<string, Peer>;
  joined: boolean;
}
let room: Room | null = null;
let active = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
let joinDeadline: ReturnType<typeof setTimeout> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
const encoder = new TextEncoder();
function send(room: Room, id: string | null, message: DidMessage) {
  room.node.sendMessage(id, encoder.encode(JSON.stringify(message)), DELIVERY_RELIABLE);
}

function disconnect() {
  const previous = room;
  room = null;
  clearTimeout(debounce);
  clearTimeout(joinDeadline);
  clearInterval(tick);
  if (!previous) return;
  for (const peer of previous.peers.values()) peer.close();
  previous.peers.clear();
  try { previous.node.leaveRoom(); } catch { /* Old callbacks and queued work are already invalidated. */ }
}

function stats(current: Room, error: string | null = state.error, synced = false) {
  if (room !== current) return;
  const peers = [...current.peers.values()].filter(p => p.ready);
  const status = error ? "error" : !current.joined ? "connecting" : peers.some(p => p.busy) ? "syncing" : "idle";
  update({ status, error, peerCount: peers.length, lastSyncedAt: synced ? Date.now() : state.lastSyncedAt });
}

function listen(current: Room, identity: DidIdentity, roomId: string) {
  const { node, peers, delegation } = current;
  let admitted: number[] = [];
  const discoveryReplies = new WeakMap<Peer, number>();
  function admit(id: string) {
    const now = Date.now();
    admitted = admitted.filter(at => now - at < 60_000);
    if (peers.size >= 16 || admitted.length >= 32) return;
    admitted.push(now);
    const peer: Peer = createDidPeer({
      identity, delegation,
      send: message => send(current, id, message),
      changed: () => stats(current),
      synced: () => stats(current, null, true),
      failed(error) {
        if (peers.get(id) !== peer) return;
        peers.delete(id);
        stats(current, error ?? state.error);
      },
    });
    peers.set(id, peer);
    return peer;
  }
  node.onEvent((event, id, payload, eventRoom) => {
    if (!id || room !== current || (eventRoom && eventRoom !== roomId) || Date.now() >= Date.parse(delegation.exp)) return;
    let peer = peers.get(id);
    if (event === EVENT_PEER_CONNECTED) {
      if (!peer) admit(id);
    } else if (event === EVENT_PEER_DISCONNECTED) {
      peer?.close();
      peers.delete(id);
      stats(current);
    } else if (event === EVENT_RAW) {
      const msg = decodeDidMessage(payload);
      if (!msg) return;
      if (msg.type === "lingo_didsync_discover") {
        if (!peer) admit(id);
        else if (!msg.reply && Date.now() - (discoveryReplies.get(peer) ?? -Infinity) >= 2_000) {
          // A rejoining device may have missed the transport's connect event.
          // Let it start a fresh challenge, even if we still have the old key.
          discoveryReplies.set(peer, Date.now());
          try { send(current, id, { v: 1, type: msg.type, reply: true }); } catch { connectionFailed(); }
        }
        return;
      }
      if (msg.type === "lingo_didsync_hello") {
        // The other device can renew its delegation or rejoin while the
        // underlying multi-room transport stays connected.
        if (peer?.remoteNonce && peer.remoteNonce !== msg.nonce) {
          peer.close();
          peers.delete(id);
          peer = undefined;
          stats(current);
        }
        peer ??= admit(id);
      }
      peer?.receive(msg);
    }
  });
}

function connectionFailed() {
  disconnect();
  update({ status: "error", error: "settings-did-connect-error", peerCount: 0 });
}
async function connect(delegation: DelegationV1) {
  let current: Room | null = null;
  try {
    current = { node: createAppNode(), delegation, peers: new Map(), joined: false };
    room = current;
    joinDeadline = setTimeout(() => { if (room === current) connectionFailed(); }, 45_000);
    const [identity, roomId] = await Promise.all([ensureDidIdentity(), didRoomId(delegation.root)]);
    if (room !== current) return;
    if (identity.did !== delegation.leaf) throw new Error("Leaf changed");
    await current.node.init();
    if (room !== current) { current.node.leaveRoom(); return; }
    listen(current, identity, roomId);
    await current.node.joinRoom(roomId);
    if (room !== current) return;
    clearTimeout(joinDeadline);
    current.joined = true;
    stats(current);
    send(current, null, { v: 1, type: "lingo_didsync_discover", reply: false });
    const peers = current.peers;
    tick = setInterval(() => { for (const peer of peers.values()) peer.tick(Date.now()); }, 2_000);
  } catch {
    if (room === current) connectionFailed();
  }
}

function reconcile() {
  if (!active) return;
  const enabled = loadSettings().didAutoSync;
  const { delegation, error } = getDidLink();
  if (!enabled || !delegation || Date.parse(delegation.exp) <= Date.now()) {
    disconnect();
    update({ ...initial, status: !enabled ? "off" : error ? "error" : "no-delegation", error: enabled ? error : null });
    return;
  }
  if (room?.delegation === delegation) return;
  disconnect();
  update({ ...initial, status: "connecting" });
  void connect(delegation);
}

export function syncDidNow() {
  if (!active) return;
  if (!room || state.status === "error") {
    disconnect();
    reconcile();
  } else {
    try { send(room, null, { v: 1, type: "lingo_didsync_discover", reply: false }); }
    catch { connectionFailed(); return; }
    for (const peer of room.peers.values()) peer.request();
  }
}

/** Called once by the app's mount effect. Settings and credential changes
 * tear down the old handle synchronously, including queued peer work. */
export function startDidSync(): () => void {
  active = true;
  const unsubscribeLink = subscribeDidLink(reconcile);
  const stopLink = watchDidLink();
  const unsubscribeWrites = subscribeStorageChanges(({ name }) => {
    if (name === "settings-v1") { reconcile(); return; }
    if (!room || !syncedStores.has(name)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { for (const peer of room?.peers.values() ?? []) void peer.push(); }, 7_000);
  });
  const fallback = setInterval(syncDidNow, 5 * 60_000);
  return () => {
    active = false;
    unsubscribeWrites();
    unsubscribeLink();
    stopLink();
    clearInterval(fallback);
    disconnect();
    update(initial);
  };
}
