// Wire messages for the device-to-device sync exchange (設定 > 同期) — see
// lib/sync/types.ts for the full session contract. Unlike lib/p2p/protocol.ts
// (which extends the @tik-choco/mistai library's own decode() so oai_*
// messages coexist with the library's llm_*/tts_*/... traffic in a shared
// room), this codec is standalone: sync rooms are private, ephemeral rooms
// created solely for one device-pairing exchange (`lingo-sync-<randomId>`),
// so no other mistai protocol messages are ever expected to arrive there —
// decodeSync() doesn't call into the library's decode() at all, it only ever
// returns a lingo_sync_* message or null.
//
// A SyncSnapshot (lib/sync/types.ts) is JSON, so it's UTF-8-encoded then
// base64'd and chunked the same way lib/p2p/tunnel.ts chunks oai_* bodies
// (mist's reliable data channel is only safe for ~16KB per message).

/** Announces this peer is ready to exchange snapshots; broadcast on join and re-sent to every newly connected peer. */
export interface SyncHelloMsg {
  v: 1;
  type: "lingo_sync_hello";
}

/** One base64 chunk of a UTF-8 JSON `SyncSnapshot`, correlated by `id`. */
export interface SyncDataMsg {
  v: 1;
  type: "lingo_sync_data";
  id: string;
  seq: number;
  last: boolean;
  data: string;
}

/** Sent by the receiver once snapshot `id` has been fully reassembled and merged. */
export interface SyncDoneMsg {
  v: 1;
  type: "lingo_sync_done";
  id: string;
}

/** Sent when a received snapshot fails validation/merge, or a chunk stream is malformed. */
export interface SyncErrorMsg {
  v: 1;
  type: "lingo_sync_error";
  message: string;
}

export type SyncMessage = SyncHelloMsg | SyncDataMsg | SyncDoneMsg | SyncErrorMsg;

const SYNC_MESSAGE_TYPES = new Set([
  "lingo_sync_hello",
  "lingo_sync_data",
  "lingo_sync_done",
  "lingo_sync_error",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isValidSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Validates a parsed `{v:1, type:"lingo_sync_*", ...}` object into a typed
 * message. Returns null for anything that doesn't match the expected shape —
 * peers are untrusted, same defensive posture as lib/p2p/protocol.ts's
 * decodeOai.
 */
function decodeSyncMessage(m: Record<string, unknown>): SyncMessage | null {
  switch (m.type) {
    case "lingo_sync_hello":
      return { v: 1, type: "lingo_sync_hello" };
    case "lingo_sync_data": {
      if (!isNonEmptyString(m.id)) return null;
      if (!isValidSeq(m.seq)) return null;
      if (typeof m.last !== "boolean") return null;
      if (typeof m.data !== "string") return null;
      return { v: 1, type: "lingo_sync_data", id: m.id, seq: m.seq, last: m.last, data: m.data };
    }
    case "lingo_sync_done": {
      if (!isNonEmptyString(m.id)) return null;
      return { v: 1, type: "lingo_sync_done", id: m.id };
    }
    case "lingo_sync_error": {
      if (typeof m.message !== "string") return null;
      return { v: 1, type: "lingo_sync_error", message: m.message };
    }
    default:
      return null;
  }
}

/** Encodes a sync message to a JSON UTF-8 byte payload for sendMessage(). */
export function encodeSync(msg: SyncMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

/**
 * Decodes and validates bytes/text received from a peer. Returns null for
 * anything that doesn't match a known, valid `lingo_sync_*` shape — peers are
 * untrusted, same defensive posture as lib/p2p/protocol.ts's decodeExtended.
 */
export function decodeSync(data: Uint8Array | string): SyncMessage | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.v !== 1) return null;
  if (typeof m.type !== "string" || !SYNC_MESSAGE_TYPES.has(m.type)) return null;
  return decodeSyncMessage(m);
}

// ---------------------------------------------------------------------------
// Chunk reassembly, factored out as a pure/testable helper (no network deps)
// so lib/sync/session.ts can stay thin over it. Mirrors lib/p2p/tunnel.ts's
// PendingClientRequest/IncomingRequest reassembly discipline: duplicate seq
// numbers are ignored, "complete" means every index up to the `last` seq is
// present, and a 24MB base64 cap guards against a malicious/broken peer.

/** Hard ceiling on reassembled base64 from a single snapshot transfer — mirrors lib/p2p/tunnel.ts's MAX_OAI_BASE64_CHARS. */
export const MAX_SYNC_BASE64_CHARS = 24 * 1024 * 1024;

export type ChunkAddResult = "added" | "duplicate" | "too-large";

/** Reassembles one chunked transfer (one peer, one message `id`). */
export class ChunkAssembler {
  private readonly parts = new Map<number, string>();
  private lastSeq: number | null = null;
  private totalLength = 0;

  /** Adds a chunk. Duplicate seq numbers are ignored (idempotent re-delivery). */
  add(seq: number, data: string, last: boolean): ChunkAddResult {
    if (this.parts.has(seq)) return "duplicate";
    this.parts.set(seq, data);
    this.totalLength += data.length;
    if (last) this.lastSeq = seq;
    if (this.totalLength > MAX_SYNC_BASE64_CHARS) return "too-large";
    return "added";
  }

  /** True once every index from 0 to the `last`-flagged seq has arrived. */
  get isComplete(): boolean {
    return this.lastSeq !== null && this.parts.size === this.lastSeq + 1;
  }

  /** Concatenates the base64 chunks in order once complete; null if incomplete or a chunk is missing. */
  assemble(): string | null {
    if (!this.isComplete || this.lastSeq === null) return null;
    let out = "";
    for (let i = 0; i <= this.lastSeq; i += 1) {
      const part = this.parts.get(i);
      if (part === undefined) return null; // can't happen given isComplete, guarded defensively
      out += part;
    }
    return out;
  }
}
