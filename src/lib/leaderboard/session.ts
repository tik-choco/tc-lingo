import {
  DELIVERY_RELIABLE,
  EVENT_PEER_CONNECTED,
  EVENT_PEER_DISCONNECTED,
  EVENT_RAW,
  getPersistentNodeId,
} from "@tik-choco/mistai";
import type { MistNodeLike } from "@tik-choco/mistai";
import { loadLlmConfig, subscribeLlmConfig } from "../llmConfig";
import { createAppNode, NODE_ID_STORAGE_KEY } from "../network";
import { loadSettings, subscribeSettings } from "../settings";
import { subscribeStorage } from "../storage";
import { decodeLeaderboard, encodeLeaderboard, normalizeLeaderboardLanguage } from "./protocol";
import type { LeaderboardMessage, LeaderboardStats } from "./protocol";
import { loadLeaderboardStats } from "./stats";

export interface PeerEntry {
  id: string;
  name: string;
  language: string;
  stats: LeaderboardStats;
  receivedAt: number;
}

interface LeaderboardState {
  status: "off" | "no-room" | "connecting" | "connected" | "error";
  roomId: string;
  selfId: string | null;
  peers: PeerEntry[];
  self: PeerEntry | null;
  error: "history-leaderboard-error-connect" | null;
}

interface Connection {
  node: MistNodeLike;
  selfId: string;
}

const BROADCAST_DEBOUNCE_MS = 2_000;
const HEARTBEAT_MS = 60_000;
const PEER_TTL_MS = 180_000;
const emptyState: LeaderboardState = { status: "off", roomId: "", selfId: null, peers: [], self: null, error: null };
const listeners = new Set<() => void>();
let state = emptyState;
let connection: Connection | null = null;
let subscriptions: (() => void)[] | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

export function getLeaderboardState(): LeaderboardState {
  return state;
}

export function subscribeLeaderboard(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function setState(patch: Partial<LeaderboardState>): void {
  state = { ...state, ...patch };
  for (const cb of listeners) cb();
}

function setPeers(peers: PeerEntry[]): void {
  clearTimeout(expiryTimer);
  if (peers.length) {
    const oldest = peers.reduce((time, peer) => Math.min(time, peer.receivedAt), Infinity);
    expiryTimer = setTimeout(() => {
      const cutoff = Date.now() - PEER_TTL_MS;
      setPeers(state.peers.filter((peer) => peer.receivedAt > cutoff));
    }, oldest + PEER_TTL_MS - Date.now());
  }
  setState({ peers });
}

function disconnect(): void {
  const previous = connection;
  connection = null;
  clearTimeout(broadcastTimer);
  clearTimeout(expiryTimer);
  clearInterval(heartbeat);
  previous?.node.leaveRoom();
}

function send(toId: string | null, message: LeaderboardMessage): void {
  try {
    connection?.node.sendMessage(toId, encodeLeaderboard(message), DELIVERY_RELIABLE);
  } catch (error) {
    // A peer can leave before a direct reply. The next heartbeat refreshes the room.
    console.debug("Study leaderboard: send failed", error);
  }
}

function ownEntry(id: string): PeerEntry {
  const { leaderboardName, activeLanguage } = loadSettings();
  return {
    id,
    name: leaderboardName,
    language: normalizeLeaderboardLanguage(activeLanguage),
    stats: loadLeaderboardStats(),
    receivedAt: Date.now(),
  };
}

function sendStats(toId: string | null, { name, language, stats }: PeerEntry): void {
  send(toId, { type: "lingo_rank_stats", v: 1, name, language, stats, sentAt: Date.now() });
}

function broadcastStats(): void {
  clearTimeout(broadcastTimer);
  if (!connection || state.status !== "connected") return;
  const self = ownEntry(connection.selfId);
  setState({ self });
  sendStats(null, self);
}

function scheduleBroadcast(): void {
  if (state.status !== "connected") return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(broadcastStats, BROADCAST_DEBOUNCE_MS);
}

function coercePayload(payload: unknown): Uint8Array | string | null {
  if (typeof payload === "string" || payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  return null;
}

function handleEvent(eventType: number, fromId: string, payload: unknown, selfId: string): void {
  if (!fromId || fromId === selfId) return;
  if (eventType === EVENT_PEER_CONNECTED) {
    sendStats(fromId, state.self ?? ownEntry(selfId));
  } else if (eventType === EVENT_PEER_DISCONNECTED) {
    const remaining = state.peers.filter((peer) => peer.id !== fromId);
    if (remaining.length !== state.peers.length) setPeers(remaining);
  } else if (eventType === EVENT_RAW) {
    const bytes = coercePayload(payload);
    const message = bytes === null ? null : decodeLeaderboard(bytes);
    if (message?.type === "lingo_rank_hello") {
      sendStats(fromId, state.self ?? ownEntry(selfId));
    } else if (message?.type === "lingo_rank_stats") {
      const { name, language, stats } = message;
      const peers = state.peers.filter((peer) => peer.id !== fromId);
      setPeers([...peers, { id: fromId, name, language, stats, receivedAt: Date.now() }]);
    }
  }
}

async function connect(roomId: string): Promise<void> {
  let next: Connection | null = null;
  try {
    const selfId = getPersistentNodeId(NODE_ID_STORAGE_KEY);
    const node = createAppNode();
    next = { node, selfId };
    connection = next;
    await node.init();
    if (connection !== next) {
      // The shared scope registers this handle when init finishes.
      node.leaveRoom();
      return;
    }
    node.onEvent((eventType, fromId, payload, eventRoomId) => {
      if (connection !== next || (eventRoomId && eventRoomId !== roomId)) return;
      handleEvent(eventType, fromId, payload, selfId);
    });
    await node.joinRoom(roomId);
    if (connection !== next) return;

    const self = ownEntry(selfId);
    setState({ status: "connected", selfId, self });
    send(null, { type: "lingo_rank_hello", v: 1 });
    sendStats(null, self);
    heartbeat = setInterval(broadcastStats, HEARTBEAT_MS);
  } catch {
    if (connection !== next) return;
    disconnect();
    setState({ ...emptyState, status: "error", roomId, error: "history-leaderboard-error-connect" });
  }
}

function reconcile(): void {
  if (!subscriptions) return;
  const { leaderboardEnabled } = loadSettings();
  const roomId = loadLlmConfig()?.network.roomId.trim() ?? "";
  if (!leaderboardEnabled || !roomId) {
    const status = leaderboardEnabled ? "no-room" : "off";
    if (state.status === status && state.roomId === roomId) return;
    disconnect();
    setState({ ...emptyState, status, roomId });
    return;
  }
  if (state.roomId === roomId && state.status !== "off") return;
  disconnect();
  setState({ ...emptyState, status: "connecting", roomId });
  void connect(roomId);
}

function scheduleReconcile(): void {
  // Both config readers can persist a migration and notify synchronously.
  queueMicrotask(reconcile);
}

export function startLeaderboard(): void {
  if (subscriptions) return;
  subscriptions = [
    subscribeSettings(scheduleReconcile),
    subscribeLlmConfig(scheduleReconcile),
    subscribeStorage(scheduleBroadcast),
  ];
  reconcile();
}

export function stopLeaderboard(): void {
  subscriptions?.forEach((unsubscribe) => unsubscribe());
  subscriptions = null;
  disconnect();
  setState(emptyState);
}
