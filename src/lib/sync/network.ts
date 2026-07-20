// Fork of @tik-choco/mistai's `Network` class (dist/node.js), mirrored the
// same way lib/p2p/network.ts forks it for the oai_* tunnel — decoding with
// this feature's own codec (./protocol.ts's decodeSync/encodeSync) instead of
// the library's own decode(). Unlike the oai tunnel (which shares a room with
// the library's own llm_*/tts_*/... traffic and so falls back to the
// library's decode() for anything it doesn't recognize), sync rooms are
// private and ephemeral (`lingo-sync-<randomId>`, created solely for one
// device-pairing exchange), so this codec never needs to understand the
// library's own message types — decodeSync() only ever returns a
// lingo_sync_* message or null.
//
// Node lifecycle, persistent node id, and event wiring are ported unchanged
// from the library (same as lib/p2p/network.ts).

import { getPersistentNodeId, type MistNodeLike } from "@tik-choco/mistai";
import { decodeSync, encodeSync, type SyncMessage } from "./protocol";

// Mist event/delivery constants, mirrored from the mistlib web wrapper (same
// values lib/p2p/network.ts mirrors) so this file doesn't have to import the
// library's own Network class just to get at them.
export const EVENT_RAW = 0;
export const EVENT_PEER_CONNECTED = 5;
export const EVENT_PEER_DISCONNECTED = 6;
export const DELIVERY_RELIABLE = 0;

export interface SyncNetworkCallbacks {
  onPeerConnected?(peerId: string): void;
  onPeerDisconnected?(peerId: string): void;
  onMessage?(fromId: string, msg: SyncMessage): void;
}

export interface SyncNetworkOptions {
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike;
  /** Explicit node id; defaults to getPersistentNodeId(nodeIdStorageKey). */
  nodeId?: string;
  /** localStorage key used by the default persistent node id. */
  nodeIdStorageKey?: string;
  callbacks?: SyncNetworkCallbacks;
}

/** Defensively coerces whatever the wrapper hands us for EVENT_RAW into decodable input. */
function coercePayload(payload: unknown): Uint8Array | string | null {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  try {
    return new Uint8Array(payload as ArrayBufferLike);
  } catch {
    return null;
  }
}

export class SyncNetwork {
  private node: MistNodeLike | null = null;
  private readonly createNode: (nodeId: string) => MistNodeLike;
  private readonly nodeId: string;
  private roomId: string | null = null;
  private disposed = false;
  private readonly callbacks: SyncNetworkCallbacks;

  constructor(options: SyncNetworkOptions) {
    this.createNode = options.createNode;
    this.nodeId = options.nodeId ?? getPersistentNodeId(options.nodeIdStorageKey);
    this.callbacks = options.callbacks ?? {};
  }

  get id(): string {
    return this.nodeId;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  async join(roomId: string): Promise<void> {
    const node = this.createNode(this.nodeId);
    await node.init();
    if (this.disposed) {
      node.leaveRoom();
      return;
    }
    node.onEvent((eventType: number, fromId: string, payload: unknown) => {
      if (this.disposed || this.node !== node) return;
      if (eventType === EVENT_RAW) {
        const bytes = coercePayload(payload);
        if (bytes === null) return;
        const msg = decodeSync(bytes);
        if (msg) this.callbacks.onMessage?.(fromId, msg);
      } else if (eventType === EVENT_PEER_CONNECTED) {
        this.callbacks.onPeerConnected?.(fromId);
      } else if (eventType === EVENT_PEER_DISCONNECTED) {
        this.callbacks.onPeerDisconnected?.(fromId);
      }
    });
    this.node = node;
    this.roomId = roomId;
    node.joinRoom(roomId);
  }

  send(toId: string | null, msg: SyncMessage): void {
    this.node?.sendMessage(toId, encodeSync(msg), DELIVERY_RELIABLE);
  }

  leave(): void {
    this.node?.leaveRoom();
    this.node = null;
    this.roomId = null;
  }

  destroy(): void {
    this.leave();
    this.disposed = true;
  }
}
