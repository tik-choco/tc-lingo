// Deletion records for the device-to-device sync feature's LWW-with-
// tombstones merge — see the header comment in ./types.ts for the full
// model. Persisted separately from the domain stores (a tombstone has no
// single "owner" domain module) under tc-lingo:sync-tombstones-v1. Same
// defensive-sanitizer convention as the domain modules (lib/cards.ts etc.):
// malformed entries are dropped, never thrown on.
//
// Every domain module's delete function (deleteCard, deleteTopic — which
// also tombstones the topic's own deleted attempts, deletePassage,
// deleteConversation) coordinates removal and tombstones. LanguageLevelRecord is the one
// synced entity with no delete path at all (no UI action removes one, and
// lib/settings.ts's removeTargetLanguage leaves the level record in place),
// so "levels" never needs a tombstone — nothing to wire up there.
import type { SyncStoreName, Tombstone } from "./types";
import { loadJson, nextUpdatedAt, saveJson, saveJsonBatch, type JsonWrite, type StorageWriteOptions } from "../storage";

const STORAGE_NAME = "sync-tombstones-v1";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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

function saveTombstones(tombstones: Tombstone[], options?: StorageWriteOptions): void {
  saveJson(STORAGE_NAME, tombstones, options);
}

/** Union of two tombstone lists by (store, id): the later `deletedAt` wins
 * for a repeated key. Pure; callers persist separately. */
export function unionTombstones(a: Tombstone[], b: Tombstone[]): Tombstone[] {
  const byKey = new Map<string, Tombstone>();
  for (const t of [...a, ...b]) {
    const key = `${t.store}:${t.id}`;
    const existing = byKey.get(key);
    if (!existing || t.deletedAt > existing.deletedAt) byKey.set(key, t);
  }
  return [...byKey.values()]
    .sort((x, y) => (x.deletedAt < y.deletedAt ? 1 : x.deletedAt > y.deletedAt ? -1 :
      x.store < y.store ? -1 : x.store > y.store ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function pruneTombstones(tombstones: Tombstone[], now = Date.now()): Tombstone[] {
  return tombstones.filter((t) => Date.parse(t.deletedAt) >= now - RETENTION_MS);
}

/** Records deletions after their last known revision. */
export function deletionTombstones(store: SyncStoreName, records: { id: string; updatedAt?: string }[], current = loadTombstones()): Tombstone[] {
  const existing = new Map(current.filter((t) => t.store === store).map((t) => [t.id, t.deletedAt]));
  const additions = records.map(({ id, updatedAt }) => {
    const previousDelete = existing.get(id);
    const previous = previousDelete && (!updatedAt || previousDelete > updatedAt) ? previousDelete : updatedAt;
    return { store, id, deletedAt: nextUpdatedAt(previous) };
  });
  return unionTombstones(current, additions);
}

export function recordTombstones(store: SyncStoreName, records: { id: string; updatedAt?: string }[]): void {
  if (records.length) saveTombstones(deletionTombstones(store, records));
}

/** Free domain space first; roll it back if remembering the deletion fails. */
export function persistDeletions(writes: JsonWrite[], deletions: { store: SyncStoreName; records: { id: string; updatedAt?: string }[] }[]): void {
  let tombstones = loadTombstones();
  for (const deletion of deletions) tombstones = deletionTombstones(deletion.store, deletion.records, tombstones);
  saveJsonBatch([...writes, { name: STORAGE_NAME, value: tombstones,
    refresh: () => unionTombstones(loadTombstones(), tombstones) }]);
}

export function recordTombstone(store: SyncStoreName, id: string, updatedAt?: string): void {
  recordTombstones(store, [{ id, updatedAt }]);
}

/** Merges and persists tombstones, keeping the latest per record. */
export function mergeTombstones(remote: Tombstone[]): void {
  saveTombstones(unionTombstones(loadTombstones(), remote));
}

export function replaceTombstonesForSync(tombstones: Tombstone[], options?: StorageWriteOptions): void {
  saveTombstones(tombstones, options);
}
