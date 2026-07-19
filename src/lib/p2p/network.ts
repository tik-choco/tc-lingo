// Fork of @tik-choco/mistai's `Network` class (dist/node.js) that decodes
// with this app's extended codec (decodeExtended/encodeExtended) instead of
// the library's own decode()/encode(), so oai_* tunnel messages survive the
// wire instead of being silently dropped by the library's type whitelist.
//
// Everything else — node lifecycle, persistent node id, event wiring — is
// ported unchanged from the library. Drop this fork (and go back to
// importing `Network` directly) once the library's decode() accepts
// registered protocol extensions instead of a hardcoded MESSAGE_TYPES set.
//
// Ported byte-for-byte from tc-translate's src/lib/p2p/network.ts.
import {
  getPersistentNodeId,
  type MistNodeLike,
} from '@tik-choco/mistai'
import { decodeExtended, encodeExtended, type ExtendedMessage } from './protocol.js'

// Mist event/delivery constants, mirrored from the mistlib web wrapper (same
// values the library's node.js uses) so this file doesn't have to import the
// library's own Network class just to get at them.
export const EVENT_RAW = 0
export const EVENT_PEER_CONNECTED = 5
export const EVENT_PEER_DISCONNECTED = 6
export const DELIVERY_RELIABLE = 0

export interface ExtendedNetworkCallbacks {
  onPeerConnected?(peerId: string): void
  onPeerDisconnected?(peerId: string): void
  onMessage?(fromId: string, msg: ExtendedMessage): void
}

export interface ExtendedNetworkOptions {
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike
  /** Explicit node id; defaults to getPersistentNodeId(nodeIdStorageKey). */
  nodeId?: string
  /** localStorage key used by the default persistent node id. */
  nodeIdStorageKey?: string
  callbacks?: ExtendedNetworkCallbacks
}

/** Defensively coerces whatever the wrapper hands us for EVENT_RAW into decodable input. */
function coercePayload(payload: unknown): Uint8Array | string | null {
  if (payload instanceof Uint8Array) return payload
  if (typeof payload === 'string') return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  try {
    return new Uint8Array(payload as ArrayBufferLike)
  } catch {
    return null
  }
}

export class ExtendedNetwork {
  private node: MistNodeLike | null = null
  private readonly createNode: (nodeId: string) => MistNodeLike
  private readonly nodeId: string
  private roomId: string | null = null
  private disposed = false
  private readonly callbacks: ExtendedNetworkCallbacks

  constructor(options: ExtendedNetworkOptions) {
    this.createNode = options.createNode
    this.nodeId = options.nodeId ?? getPersistentNodeId(options.nodeIdStorageKey)
    this.callbacks = options.callbacks ?? {}
  }

  get id(): string {
    return this.nodeId
  }

  get currentRoomId(): string | null {
    return this.roomId
  }

  async join(roomId: string): Promise<void> {
    const node = this.createNode(this.nodeId)
    await node.init()
    if (this.disposed) {
      node.leaveRoom()
      return
    }
    node.onEvent((eventType: number, fromId: string, payload: unknown) => {
      if (this.disposed || this.node !== node) return
      if (eventType === EVENT_RAW) {
        const bytes = coercePayload(payload)
        if (bytes === null) return
        const msg = decodeExtended(bytes)
        if (msg) this.callbacks.onMessage?.(fromId, msg)
      } else if (eventType === EVENT_PEER_CONNECTED) {
        this.callbacks.onPeerConnected?.(fromId)
      } else if (eventType === EVENT_PEER_DISCONNECTED) {
        this.callbacks.onPeerDisconnected?.(fromId)
      }
    })
    this.node = node
    this.roomId = roomId
    node.joinRoom(roomId)
  }

  send(toId: string | null, msg: ExtendedMessage): void {
    this.node?.sendMessage(toId, encodeExtended(msg), DELIVERY_RELIABLE)
  }

  leave(): void {
    this.node?.leaveRoom()
    this.node = null
    this.roomId = null
  }

  destroy(): void {
    this.leave()
    this.disposed = true
  }
}
