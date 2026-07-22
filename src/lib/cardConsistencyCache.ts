// Local-only "already checked this card's front/cloze/exampleSentence for
// internal consistency" cache for lib/reviewConsistencyCheck.ts. Same
// rationale as lib/cardEmbeddingCache.ts: derived/cheap-to-recompute data,
// not part of the Card type or the sync contract, and read/written directly
// via localStorage (not lib/storage.ts's loadJson/saveJson) so a cache write
// doesn't broadcast a spurious change event to every subscribeStorage
// listener in the app.
import { hashText } from "./textHash";

const STORAGE_KEY = "tc-lingo:card-consistency-checked-v1";

/** cardId -> hash of the (front, cloze, exampleSentence) triple that was
 * last checked and found consistent (or fixed to be consistent) — so an
 * unmodified card is never re-sent to the LLM twice. */
export type CardConsistencyCache = Record<string, string>;

export function hashCardConsistencyInput(front: string, cloze: string, exampleSentence: string): string {
  return hashText(`${front}${cloze}${exampleSentence}`);
}

export function loadCardConsistencyCache(): CardConsistencyCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const result: CardConsistencyCache = {};
    for (const [id, hash] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof hash === "string") result[id] = hash;
    }
    return result;
  } catch {
    return {};
  }
}

/** Marks `cardId` as checked for its current content hash. Persists
 * immediately (read-modify-write against the latest stored cache, not just
 * the caller's possibly-stale in-memory copy) since checks land one at a
 * time from independent background calls. */
export function markCardConsistencyChecked(cardId: string, hash: string): void {
  const cache = loadCardConsistencyCache();
  cache[cardId] = hash;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.warn("tc-lingo: failed to persist card consistency cache", error);
  }
}
