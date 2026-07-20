// Deletion records for the device-to-device sync feature's LWW-with-
// tombstones merge — see the header comment in ./types.ts for the full
// model. Persisted separately from the domain stores (a tombstone has no
// single "owner" domain module) under tc-lingo:sync-tombstones-v1. Same
// defensive-sanitizer convention as the domain modules (lib/cards.ts etc.):
// malformed entries are dropped, never thrown on.
//
// Every domain module's delete function (deleteCard, deleteTopic — which
// also tombstones the topic's own deleted attempts, deletePassage,
// deleteConversation) calls recordTombstone. LanguageLevelRecord is the one
// synced entity with no delete path at all (no UI action removes one, and
// lib/settings.ts's removeTargetLanguage leaves the level record in place),
// so "levels" never needs a tombstone — nothing to wire up there.
import type { SyncStoreName, Tombstone } from "./types";
import { loadJson, saveJson } from "../storage";

const STORAGE_NAME = "sync-tombstones-v1";

/** Oldest tombstones are dropped once the list exceeds this — a very old
 * deletion is unlikely to still matter (any peer that needed it to suppress
 * a resurrected entity has almost certainly synced by now), and keeping
 * every deletion ever made would grow this list unboundedly. */
const MAX_TOMBSTONES = 2000;

const STORE_NAMES: SyncStoreName[] = ["cards", "topics", "attempts", "passages", "conversations", "levels"];

function isSyncStoreName(value: unknown): value is SyncStoreName {
  return typeof value === "string" && (STORE_NAMES as string[]).includes(value);
}

function isTombstone(value: unknown): value is Tombstone {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return isSyncStoreName(r.store) && typeof r.id === "string" && typeof r.deletedAt === "string";
}

/** Exported so lib/sync/snapshot.ts can validate a remote snapshot's
 * tombstones with the exact same rules used to load local ones. */
export function sanitizeTombstones(raw: unknown): Tombstone[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTombstone);
}

export function loadTombstones(): Tombstone[] {
  return sanitizeTombstones(loadJson<unknown[]>(STORAGE_NAME, []));
}

function saveTombstones(tombstones: Tombstone[]): void {
  saveJson(STORAGE_NAME, tombstones);
}

/** Union of two tombstone lists by (store, id): the later `deletedAt` wins
 * for a repeated key. Pure (callers persist separately) and capped at the
 * MAX_TOMBSTONES newest by deletedAt, so every caller — recordTombstone,
 * mergeTombstones, and lib/sync/snapshot.ts's own merge pass, which needs
 * the same combined view to decide what an incoming tombstone removes —
 * observes an identical result. Exported for that last use. */
export function unionTombstones(a: Tombstone[], b: Tombstone[]): Tombstone[] {
  const byKey = new Map<string, Tombstone>();
  for (const t of [...a, ...b]) {
    const key = `${t.store}:${t.id}`;
    const existing = byKey.get(key);
    if (!existing || t.deletedAt > existing.deletedAt) byKey.set(key, t);
  }
  return [...byKey.values()]
    .sort((x, y) => (x.deletedAt < y.deletedAt ? 1 : x.deletedAt > y.deletedAt ? -1 : 0))
    .slice(0, MAX_TOMBSTONES);
}

/** Records one local deletion (upsert: recording the same store+id again —
 * shouldn't normally happen, an id is deleted once — just refreshes
 * deletedAt to now). Called by every domain module's delete function. */
export function recordTombstone(store: SyncStoreName, id: string): void {
  const tombstone: Tombstone = { store, id, deletedAt: new Date().toISOString() };
  saveTombstones(unionTombstones(loadTombstones(), [tombstone]));
}

/** Merges a remote peer's tombstone list into the local one (union by
 * store+id, latest deletedAt wins) and persists the result. */
export function mergeTombstones(remote: Tombstone[]): void {
  saveTombstones(unionTombstones(loadTombstones(), remote));
}
