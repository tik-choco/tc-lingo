// Shared contract for the device-to-device data sync feature (設定 > 同期).
//
// How sync works (one-shot session, no background replication):
// - The HOST opens 設定 > 同期 and starts a session: a random mist room id
//   (`lingo-sync-<randomId>`) is joined via the shared MistNode and shown as
//   a URL + QR code (`#/sync/<roomId>` deep link — see lib/hashRoute.ts).
// - The GUEST opens that URL on another device (scanning the QR with the
//   phone camera opens the browser — no in-app QR decoding needed), confirms,
//   and joins the same room.
// - Both peers exchange their full `SyncSnapshot` (chunked over the wire —
//   see lib/sync/protocol.ts) and each side merges the remote snapshot into
//   local storage (lib/sync/snapshot.ts). The merge is symmetric, so both
//   devices converge without a designated "master".
//
// Merge model — an LWW-element-map with tombstones (a state-based CRDT:
// merging is commutative, associative and idempotent, so any number of
// pairwise syncs in any order converges):
// - Every synced entity carries `updatedAt` (ISO string), bumped by every
//   mutation in its domain module (never by mere loads).
// - Same key on both sides → the copy with the greater `updatedAt` wins.
//   Exact tie → the copy whose JSON.stringify is lexicographically greater
//   wins (deterministic and symmetric, so both sides pick the same copy).
// - Deletions are recorded as tombstones (lib/sync/tombstones.ts). Entity vs
//   tombstone for the same key: entity survives iff updatedAt > deletedAt
//   (an edit after the delete resurrects it; otherwise the delete wins).
//   Tombstone sets merge as a union (same key → latest deletedAt).
// - Entities keyed by `id`, except "levels" which is keyed by `language`.
//
// Out of scope (deliberately not synced): LingoSettings (device-local,
// includes connection mode), the shared llm config (co-owned cross-app
// contract with its own merge rules), and the card-inbox cursor state.

import type {
  Card,
  ConversationSession,
  LanguageLevelRecord,
  PracticeAttempt,
  ReadingPassage,
  Topic,
} from "../../types";

/** The localStorage-backed stores that participate in sync. */
export type SyncStoreName =
  | "cards"
  | "topics"
  | "attempts"
  | "passages"
  | "conversations"
  | "levels";

/** A recorded deletion; the sync-time counterpart of a missing entity. */
export interface Tombstone {
  store: SyncStoreName;
  /** The entity's merge key: its `id` ("levels": its `language`). */
  id: string;
  /** ISO timestamp of the local delete. */
  deletedAt: string;
}

/** The full state one device offers to the other. Version-gated so a future
 * shape change can refuse (rather than mis-merge) an old peer's snapshot. */
export interface SyncSnapshot {
  v: 1;
  app: "tc-lingo";
  cards: Card[];
  topics: Topic[];
  attempts: PracticeAttempt[];
  passages: ReadingPassage[];
  conversations: ConversationSession[];
  levels: LanguageLevelRecord[];
  tombstones: Tombstone[];
}

export interface SyncStoreCounts {
  added: number;
  updated: number;
  removed: number;
}

/** What one merge pass changed locally, per store (for the result screen). */
export type SyncMergeSummary = Record<SyncStoreName, SyncStoreCounts>;

// ---------------------------------------------------------------------------
// Session state (lib/sync/session.ts — a module-level singleton store the UI
// subscribes to, same pattern as the domain modules' subscribe*).

export type SyncRole = "host" | "guest";

export type SyncPhase =
  | "idle"
  | "connecting" // joining the room
  | "waiting" // in the room, no peer exchange completed yet
  | "exchanging" // snapshot transfer/merge in flight
  | "done" // at least one merge completed (summary is set)
  | "error"; // error is set (session torn down)

/**
 * `error` is an i18n message KEY (per the repo rule: never store translated
 * strings in module state), one of:
 *   "settings-sync-error-connect"   — joining the room failed
 *   "settings-sync-error-timeout"   — no peer / no snapshot within the window
 *   "settings-sync-error-peer-left" — peer disconnected mid-exchange
 *   "settings-sync-error-data"      — remote snapshot failed validation
 * The UI resolves it via t(); lib code never localizes.
 */
export interface SyncSessionState {
  phase: SyncPhase;
  role: SyncRole | null;
  roomId: string | null;
  /** Present while a `#/sync/<roomId>` deep link awaits user confirmation. */
  pendingJoinRoomId: string | null;
  /** Peers currently visible in the room (host UI shows 待機中/接続済み). */
  peerCount: number;
  error: string | null;
  summary: SyncMergeSummary | null;
  /** Counters for the current session, shown as a small diagnostic line in
   * the "waiting"/"exchanging" UI so a stalled exchange (peer visible but no
   * progress) can be triaged from the screen alone, without DevTools access.
   * Not part of the wire contract; reset by every stopSync(). */
  debug: SyncDebugCounters;
}

export interface SyncDebugCounters {
  /** Times a `lingo_sync_hello` was received from any peer. */
  helloReceived: number;
  /** `lingo_sync_data` chunks sent out (to any peer). */
  dataChunksSent: number;
  /** `lingo_sync_data` chunks received (from any peer) that weren't duplicates. */
  dataChunksReceived: number;
}
