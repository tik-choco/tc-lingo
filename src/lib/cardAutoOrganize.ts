// Background, silent card-deck cleanup: unlike CardsView's manual "類似カード
// を整理" button (requestCardMerges + CardMergePanel, always asks first), this
// runs unattended and merges cards it's confident about with no approval UI —
// see types.ts's LingoSettings.autoOrganizeCards. Same "fire-and-forget,
// gated by a settings flag, swallow errors" shape as lib/autoExtract.ts.
//
// Two-stage pipeline, cheapest filter first:
// 1. Embeddings (the "card-organize" task, see connectionForTask) cheaply
//    flag *candidate* near-duplicate clusters via cosine similarity — cheap
//    enough to run over the whole deck, but not semantically reliable on its
//    own (e.g. antonyms/topically-related-but-distinct words can score high).
// 2. Only those candidates go to the existing requestCardMerges chat call
//    (the "generation" task — same one the manual button uses), whose prompt
//    already refuses to merge cards with genuinely different meanings. Only
//    what THAT step actually returns gets merged.
//
// A capped number of clusters is processed per run (MAX_CANDIDATE_CLUSTERS_PER_RUN)
// and a cooldown gates how often runs happen at all, so the deck converges
// gradually across days rather than in one large pass.
import type { Card } from "../types";
import { loadCards, mergeCards } from "./cards";
import { requestEmbeddings } from "./embeddings";
import { hashCardText, loadEmbeddingCache, saveEmbeddingCache } from "./cardEmbeddingCache";
import type { CardEmbeddingCache } from "./cardEmbeddingCache";
import { requestCardMerges } from "./llm";
import { connectionForTask } from "./llmConnection";
import { loadSettings, markCardAutoOrganizeRan } from "./settings";

const AUTO_ORGANIZE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.9;
const MAX_CANDIDATE_CLUSTERS_PER_RUN = 5;
/** Skips a language's clustering pass above this many cards — the pairwise
 * similarity scan is O(n^2), and this is a background pass that must not
 * visibly stall the tab. The manual "類似カードを整理" button has no such cap
 * since a learner triggering it is already expecting to wait. */
const MAX_CARDS_PER_LANGUAGE_GROUP = 300;

interface Cluster {
  language: string;
  cardIds: string[];
  avgSimilarity: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Union-find over one language's cards, connecting any pair at/above
 * SIMILARITY_THRESHOLD, then reports every resulting group of 2+ as a
 * Cluster (avgSimilarity = mean of its members' pairwise similarities). */
function findClusters(language: string, cards: Card[], cache: CardEmbeddingCache): Cluster[] {
  const withVectors = cards.filter((c) => cache[c.id]);
  if (withVectors.length < 2) return [];

  const parent = new Map<string, string>(withVectors.map((c) => [c.id, c.id]));
  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = id;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const similarities = new Map<string, number>();
  for (let i = 0; i < withVectors.length; i++) {
    for (let j = i + 1; j < withVectors.length; j++) {
      const a = withVectors[i];
      const b = withVectors[j];
      const sim = cosineSimilarity(cache[a.id].vector, cache[b.id].vector);
      similarities.set(pairKey(a.id, b.id), sim);
      if (sim >= SIMILARITY_THRESHOLD) union(a.id, b.id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const c of withVectors) {
    const root = find(c.id);
    const list = groups.get(root) ?? [];
    list.push(c.id);
    groups.set(root, list);
  }

  const clusters: Cluster[] = [];
  for (const cardIds of groups.values()) {
    if (cardIds.length < 2) continue;
    const pairSims: number[] = [];
    for (let i = 0; i < cardIds.length; i++) {
      for (let j = i + 1; j < cardIds.length; j++) {
        pairSims.push(similarities.get(pairKey(cardIds[i], cardIds[j])) ?? SIMILARITY_THRESHOLD);
      }
    }
    const avgSimilarity = pairSims.reduce((s, v) => s + v, 0) / pairSims.length;
    clusters.push({ language, cardIds, avgSimilarity });
  }
  return clusters;
}

function toEmbeddingText(card: Card): string {
  return `${card.front} ${card.meaning}`;
}

/** Runs one background auto-organize pass. Safe to call on every app
 * mount — internally gated by `settings.autoOrganizeCards`, a cooldown, and
 * whether both the "card-organize" (embeddings) and "generation" (merge
 * confirmation) tasks currently resolve to a usable connection. Never
 * throws — best-effort, same as lib/autoExtract.ts. */
export async function runCardAutoOrganize(now: Date = new Date()): Promise<void> {
  try {
    const settings = loadSettings();
    if (!settings.autoOrganizeCards) return;

    if (settings.lastCardAutoOrganizeAt) {
      const elapsed = now.getTime() - new Date(settings.lastCardAutoOrganizeAt).getTime();
      if (elapsed < AUTO_ORGANIZE_COOLDOWN_MS) return;
    }

    // Embeddings aren't available over the AI Network room transport, so
    // the pre-filter stage requires a direct API connection specifically.
    const embeddingConn = connectionForTask("card-organize");
    if (!embeddingConn || embeddingConn.kind !== "api") return;
    const mergeConn = connectionForTask("generation");
    if (!mergeConn) return;

    const allCards = loadCards();
    const cardsById = new Map(allCards.map((c) => [c.id, c]));
    const cache = loadEmbeddingCache();
    const model = embeddingConn.target.model;

    const clusters: Cluster[] = [];
    for (const language of settings.targetLanguages) {
      const cards = allCards.filter((c) => c.language === language);
      if (cards.length < 2 || cards.length > MAX_CARDS_PER_LANGUAGE_GROUP) continue;

      const stale = cards.filter((c) => cache[c.id]?.hash !== hashCardText(c.front, c.meaning, model));
      if (stale.length > 0) {
        const vectors = await requestEmbeddings(embeddingConn.target, stale.map(toEmbeddingText));
        stale.forEach((c, i) => {
          cache[c.id] = { hash: hashCardText(c.front, c.meaning, model), vector: vectors[i] };
        });
      }

      clusters.push(...findClusters(language, cards, cache));
    }

    saveEmbeddingCache(cache, new Set(allCards.map((c) => c.id)));

    clusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
    const selected = clusters.slice(0, MAX_CANDIDATE_CLUSTERS_PER_RUN);

    const selectedByLanguage = new Map<string, string[][]>();
    for (const cluster of selected) {
      const list = selectedByLanguage.get(cluster.language) ?? [];
      list.push(cluster.cardIds);
      selectedByLanguage.set(cluster.language, list);
    }

    for (const [language, cardIdGroups] of selectedByLanguage) {
      const cardsForRequest = [...new Set(cardIdGroups.flat())]
        .map((id) => cardsById.get(id))
        .filter((c): c is Card => c !== undefined)
        .map((c) => ({
          id: c.id,
          front: c.front,
          reading: c.reading,
          meaning: c.meaning,
          exampleSentence: c.exampleSentence,
          context: c.context,
          cloze: c.cloze,
        }));
      if (cardsForRequest.length < 2) continue;

      const groups = await requestCardMerges({
        connection: mergeConn,
        targetLanguage: language,
        nativeLanguage: settings.nativeLanguage,
        cards: cardsForRequest,
      });
      for (const group of groups) {
        mergeCards(group.cardIds, group.merged);
      }
    }

    markCardAutoOrganizeRan(now.toISOString());
  } catch (error) {
    console.warn("tc-lingo: card auto-organize pass failed", error);
  }
}
