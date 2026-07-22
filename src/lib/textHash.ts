// Cheap, non-cryptographic string hash shared by the local-only card caches
// (lib/cardEmbeddingCache.ts, lib/cardConsistencyCache.ts) that need to
// detect "this card's relevant text changed" without storing a timestamp.
/** djb2, truncated to a base36 string. */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
