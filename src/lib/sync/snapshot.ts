// Implements the LWW-element-map-with-tombstones merge documented in the
// header comment of ./types.ts. This is the only module allowed to call the
// domain modules' replace*ForSync bulk-persist functions (lib/cards.ts's
// replaceCardsForSync, lib/topics.ts's replaceTopicsForSync/
// replaceAttemptsForSync, lib/reading.ts's replacePassagesForSync,
// lib/conversation.ts's replaceConversationsForSync, lib/level.ts's
// replaceLevelsForSync) — see each of those functions' doc comments.
import { loadCards, replaceCardsForSync, sanitizeCards } from "../cards";
import {
  loadAttempts,
  loadTopics,
  replaceAttemptsForSync,
  replaceTopicsForSync,
  sanitizeAttempts,
  sanitizeTopics,
} from "../topics";
import { loadPassages, replacePassagesForSync, sanitizePassages } from "../reading";
import { loadConversations, replaceConversationsForSync, sanitizeConversations } from "../conversation";
import { isLevelRecord, loadLevels, replaceLevelsForSync } from "../level";
import { loadTombstones, mergeTombstones, sanitizeTombstones, unionTombstones } from "./tombstones";
import type { SyncMergeSummary, SyncSnapshot, SyncStoreCounts, SyncStoreName } from "./types";

const SNAPSHOT_VERSION = 1;
const APP_ID = "tc-lingo";

/** Captures this device's full synced state. See ./types.ts for why
 * LingoSettings, the shared llm config, and the card-inbox cursor are
 * deliberately excluded. */
export function buildSyncSnapshot(): SyncSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    app: APP_ID,
    cards: loadCards(),
    topics: loadTopics(),
    attempts: loadAttempts(),
    passages: loadPassages(),
    conversations: loadConversations(),
    levels: loadLevels(),
    tombstones: loadTombstones(),
  };
}

/** Loose top-level shape check: version/app match and every store field is
 * an array. Individual entities within those arrays are validated (and
 * dropped if invalid) later by sanitizeCards/sanitizeTopics/etc. — a single
 * malformed entity must not invalidate the whole snapshot, only a wrong
 * version/app or a fundamentally wrong shape does. */
function isSnapshotShape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    r.app === "tc-lingo" &&
    Array.isArray(r.cards) &&
    Array.isArray(r.topics) &&
    Array.isArray(r.attempts) &&
    Array.isArray(r.passages) &&
    Array.isArray(r.conversations) &&
    Array.isArray(r.levels) &&
    Array.isArray(r.tombstones)
  );
}

/** Same-key winner per ./types.ts's merge rule: the copy with the greater
 * `updatedAt` wins; an exact tie is broken by the lexicographically greater
 * JSON.stringify (deterministic and symmetric, so both peers pick the same
 * copy independently). */
function pickWinner<T extends { updatedAt: string }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** Merges one store's local + remote entities under the combined tombstone
 * view, returning the merged array plus counts for the result screen.
 * `changed` is false when the merged array is exactly the local one (down to
 * content, not just reference) — lets the caller skip a pointless
 * replace*ForSync write + change-event when nothing actually moved, and is
 * what makes a second merge of the same snapshot produce an all-zero
 * summary (idempotence). */
function mergeStore<T extends { updatedAt: string }>(
  local: T[],
  remote: T[],
  keyOf: (item: T) => string,
  store: SyncStoreName,
  tombstoneDeletedAtByKey: Map<string, string>,
): { merged: T[]; counts: SyncStoreCounts; changed: boolean } {
  const localMap = new Map(local.map((item) => [keyOf(item), item]));
  const remoteMap = new Map(remote.map((item) => [keyOf(item), item]));
  const keys = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);

  const merged: T[] = [];
  const counts: SyncStoreCounts = { added: 0, updated: 0, removed: 0 };
  let changed = false;

  for (const key of keys) {
    const localItem = localMap.get(key);
    const remoteItem = remoteMap.get(key);
    const winner = localItem && remoteItem ? pickWinner(localItem, remoteItem) : (localItem ?? remoteItem)!;

    // Entity survives iff its updatedAt is strictly after the tombstone's
    // deletedAt for this key (a later edit resurrects it; otherwise the
    // delete wins). No tombstone for this key at all → always survives.
    const deletedAt = tombstoneDeletedAtByKey.get(`${store}:${key}`);
    const survives = deletedAt === undefined || winner.updatedAt > deletedAt;

    if (survives) {
      merged.push(winner);
      if (!localItem) {
        counts.added++;
        changed = true;
      } else if (JSON.stringify(winner) !== JSON.stringify(localItem)) {
        counts.updated++;
        changed = true;
      }
      // else: local already held this exact content — no-op, not counted.
    } else if (localItem) {
      counts.removed++;
      changed = true;
    }
    // else: no local entity and it doesn't survive — nothing to do/count.
  }

  return { merged, counts, changed };
}

/** Validates + merges a remote snapshot into local storage. Returns null
 * (and changes nothing) when `remote` is not a valid v1 snapshot; otherwise
 * returns what changed locally. Only stores that actually changed are
 * persisted (avoids pointless change-event storms); tombstones are always
 * merged (union with remote's, capped) regardless of whether any entity
 * store changed. Idempotent (merging the same snapshot twice yields an
 * all-zero summary the second time) and commutative between two peers — see
 * ./types.ts's header for why that's the point of this merge model. */
export function mergeSyncSnapshot(remote: unknown): SyncMergeSummary | null {
  if (!isSnapshotShape(remote)) return null;

  const remoteCards = sanitizeCards(remote.cards);
  const remoteTopics = sanitizeTopics(remote.topics);
  const remoteAttempts = sanitizeAttempts(remote.attempts);
  const remotePassages = sanitizePassages(remote.passages);
  const remoteConversations = sanitizeConversations(remote.conversations);
  const remoteLevels = (remote.levels as unknown[]).filter(isLevelRecord);
  const remoteTombstones = sanitizeTombstones(remote.tombstones);

  // Tombstones from both sides are merged first (pure, not yet persisted) so
  // the entity merge below can consult one combined view — a tombstone that
  // only the remote peer knows about must still be able to remove a local
  // entity, and vice versa.
  const combinedTombstones = unionTombstones(loadTombstones(), remoteTombstones);
  const tombstoneDeletedAtByKey = new Map(combinedTombstones.map((t) => [`${t.store}:${t.id}`, t.deletedAt]));

  const cardsResult = mergeStore(loadCards(), remoteCards, (c) => c.id, "cards", tombstoneDeletedAtByKey);
  const topicsResult = mergeStore(loadTopics(), remoteTopics, (t) => t.id, "topics", tombstoneDeletedAtByKey);
  const attemptsResult = mergeStore(loadAttempts(), remoteAttempts, (a) => a.id, "attempts", tombstoneDeletedAtByKey);
  const passagesResult = mergeStore(loadPassages(), remotePassages, (p) => p.id, "passages", tombstoneDeletedAtByKey);
  const conversationsResult = mergeStore(
    loadConversations(),
    remoteConversations,
    (s) => s.id,
    "conversations",
    tombstoneDeletedAtByKey,
  );
  const levelsResult = mergeStore(loadLevels(), remoteLevels, (l) => l.language, "levels", tombstoneDeletedAtByKey);

  if (cardsResult.changed) replaceCardsForSync(cardsResult.merged);
  if (topicsResult.changed) replaceTopicsForSync(topicsResult.merged);
  if (attemptsResult.changed) replaceAttemptsForSync(attemptsResult.merged);
  if (passagesResult.changed) replacePassagesForSync(passagesResult.merged);
  if (conversationsResult.changed) replaceConversationsForSync(conversationsResult.merged);
  if (levelsResult.changed) replaceLevelsForSync(levelsResult.merged);
  // Always merge tombstones, even when no entity store changed — the remote
  // peer's deletions still need to be remembered locally for future merges.
  mergeTombstones(remoteTombstones);

  return {
    cards: cardsResult.counts,
    topics: topicsResult.counts,
    attempts: attemptsResult.counts,
    passages: passagesResult.counts,
    conversations: conversationsResult.counts,
    levels: levelsResult.counts,
  };
}
