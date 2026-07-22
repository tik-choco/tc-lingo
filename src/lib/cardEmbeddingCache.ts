// Local-only cache of card embedding vectors for lib/cardAutoOrganize.ts.
// Deliberately NOT part of the Card type or the device-to-device sync
// contract (lib/sync/) — an embedding is derived data, cheap enough to
// recompute per device, and not worth the sync payload size (a real
// embedding model's vectors run into the hundreds/thousands of floats).
//
// Reads/writes localStorage directly instead of going through
// lib/storage.ts's loadJson/saveJson: saveJson's notifyChanged() broadcasts
// to every subscribeStorage listener in the app (CardsView, ReviewView,
// ...), and this cache has no UI subscriber of its own — routing through it
// would just cause spurious re-renders every time the background pass
// updates an embedding.
import { hashText } from "./textHash";

const STORAGE_KEY = "tc-lingo:card-embeddings-v1";

export interface CardEmbeddingEntry {
  /** Cheap hash of the text the vector was computed from (front + meaning) —
   * lets a content edit invalidate the cache without needing a timestamp. */
  hash: string;
  vector: number[];
}

export type CardEmbeddingCache = Record<string, CardEmbeddingEntry>;

function isCardEmbeddingEntry(value: unknown): value is CardEmbeddingEntry {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.hash === "string" && Array.isArray(r.vector) && r.vector.every((n) => typeof n === "number");
}

/** Detects "this card's text changed" (or "the card-organize task's
 * embedding model changed" — `model` is folded into the hash too, so
 * switching models invalidates every cached vector instead of silently
 * comparing vectors from two different embedding spaces). */
export function hashCardText(front: string, meaning: string, model: string): string {
  return hashText(`${model} ${front} ${meaning}`);
}

export function loadEmbeddingCache(): CardEmbeddingCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const result: CardEmbeddingCache = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isCardEmbeddingEntry(entry)) result[id] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

/** Persists `cache`, dropping any entry whose card id isn't in
 * `liveCardIds` (so deleted/merged-away cards don't accumulate forever). */
export function saveEmbeddingCache(cache: CardEmbeddingCache, liveCardIds: ReadonlySet<string>): void {
  const pruned: CardEmbeddingCache = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (liveCardIds.has(id)) pruned[id] = entry;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
  } catch (error) {
    console.warn("tc-lingo: failed to persist card embedding cache", error);
  }
}
