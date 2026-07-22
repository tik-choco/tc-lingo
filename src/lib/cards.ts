// Card CRUD + defensive (de)serialization. Persistence key: tc-lingo:cards-v1.
import type { Card, CardSource, ReviewGrade } from "../types";
import { initialSrsFields, scheduleReview, isDue } from "./srs";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";
import { recordTombstone } from "./sync/tombstones";

const STORAGE_NAME = "cards-v1";

/** Exported so lib/sync/snapshot.ts can validate remote cards with the exact
 * same rules used to load local ones. `updatedAt` is optional here to accept
 * cards saved before the sync feature existed — see sanitizeCards. */
export function isCard(value: unknown): value is Card {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.front === "string" &&
    typeof r.reading === "string" &&
    typeof r.meaning === "string" &&
    typeof r.exampleSentence === "string" &&
    (r.exampleSentenceTranslation === undefined || typeof r.exampleSentenceTranslation === "string") &&
    typeof r.context === "string" &&
    typeof r.cloze === "string" &&
    (r.source === "manual" || r.source === "mistake" || r.source === "translate" || r.source === "sentence") &&
    (r.sourceTopicId === null || typeof r.sourceTopicId === "string") &&
    (r.language === undefined || typeof r.language === "string") &&
    typeof r.createdAt === "string" &&
    typeof r.dueAt === "string" &&
    typeof r.intervalDays === "number" &&
    typeof r.easeFactor === "number" &&
    typeof r.reps === "number" &&
    typeof r.lapses === "number" &&
    (r.updatedAt === undefined || typeof r.updatedAt === "string")
  );
}

/** Filters + backfills a raw array into valid Cards: `language` predates
 * multi-language support on some saved cards (backfilled to "", shown
 * regardless of the active language filter, rather than dropping the card);
 * `exampleSentenceTranslation` predates the translation-reveal feature
 * (backfilled to ""); `updatedAt` predates the sync feature (backfilled to
 * `createdAt` — a stable, deterministic timestamp, not `now`, so a pre-sync
 * card doesn't spuriously look newer than it is). Exported so
 * lib/sync/snapshot.ts can apply identical sanitization to a remote
 * snapshot's cards. */
export function sanitizeCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCard).map((c) => ({
    ...c,
    language: c.language ?? "",
    exampleSentenceTranslation: c.exampleSentenceTranslation ?? "",
    updatedAt: c.updatedAt ?? c.createdAt,
  }));
}

export function loadCards(): Card[] {
  return sanitizeCards(loadJson<unknown[]>(STORAGE_NAME, []));
}

function saveCards(cards: Card[]): void {
  saveJson(STORAGE_NAME, cards);
}

export function subscribeCards(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export interface NewCardInput {
  front: string;
  reading?: string;
  meaning: string;
  exampleSentence?: string;
  exampleSentenceTranslation?: string;
  context?: string;
  cloze?: string;
  source?: CardSource;
  sourceTopicId?: string | null;
  /** Defaults to "" (unassigned, visible under every language filter) so
   * existing call sites that don't yet pass a language keep working. */
  language?: string;
}

export function addCard(input: NewCardInput): Card {
  const now = new Date().toISOString();
  const card: Card = {
    id: newId(),
    front: input.front.trim(),
    reading: (input.reading ?? "").trim(),
    meaning: input.meaning.trim(),
    exampleSentence: (input.exampleSentence ?? "").trim(),
    exampleSentenceTranslation: (input.exampleSentenceTranslation ?? "").trim(),
    context: (input.context ?? "").trim(),
    cloze: (input.cloze ?? "").trim(),
    source: input.source ?? "manual",
    sourceTopicId: input.sourceTopicId ?? null,
    language: input.language ?? "",
    createdAt: now,
    updatedAt: now,
    ...initialSrsFields(),
  };
  saveCards([...loadCards(), card]);
  return card;
}

export function updateCard(id: string, patch: Partial<NewCardInput>): void {
  const now = new Date().toISOString();
  const cards = loadCards().map((c) =>
    c.id === id
      ? {
          ...c,
          ...(patch.front !== undefined ? { front: patch.front.trim() } : {}),
          ...(patch.reading !== undefined ? { reading: patch.reading.trim() } : {}),
          ...(patch.meaning !== undefined ? { meaning: patch.meaning.trim() } : {}),
          ...(patch.exampleSentence !== undefined ? { exampleSentence: patch.exampleSentence.trim() } : {}),
          ...(patch.exampleSentenceTranslation !== undefined
            ? { exampleSentenceTranslation: patch.exampleSentenceTranslation.trim() }
            : {}),
          ...(patch.context !== undefined ? { context: patch.context.trim() } : {}),
          ...(patch.cloze !== undefined ? { cloze: patch.cloze.trim() } : {}),
          updatedAt: now,
        }
      : c,
  );
  saveCards(cards);
}

export function deleteCard(id: string): void {
  saveCards(loadCards().filter((c) => c.id !== id));
  recordTombstone("cards", id);
}

export function gradeCard(id: string, grade: ReviewGrade, now: Date = new Date()): void {
  const cards = loadCards().map((c) =>
    c.id === id ? { ...c, ...scheduleReview(c, grade, now), updatedAt: now.toISOString() } : c,
  );
  saveCards(cards);
}

/** `language`, when given, also matches cards saved with "" (unassigned) so
 * pre-multi-language cards don't get orphaned out of every filtered queue.
 * Ordered by `lapses` descending first, `dueAt` ascending as a tiebreak —
 * every card here is already due (isDue), so this only reorders *within*
 * that set: consistently hard cards (more past "again" grades) surface
 * earlier in the session, while attention is freshest, rather than being
 * ordered purely by which happened to become due first. */
export function dueCards(now: Date = new Date(), language?: string): Card[] {
  return loadCards()
    .filter((c) => isDue(c, now) && (!language || c.language === language || c.language === ""))
    .sort((a, b) => b.lapses - a.lapses || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

/** Merges `cardIds` (2 or more) into a single card, for CardsView's LLM-
 * assisted "類似カードを整理" cleanup tool (see lib/llm.ts requestCardMerges).
 * The survivor is whichever of the given cards has made the most learning
 * progress — highest `reps`, then highest `intervalDays`, then oldest
 * `createdAt` to break remaining ties deterministically — so consolidating
 * near-duplicate cards doesn't reset SRS progress back to new. Its content
 * fields are replaced with `merged` via updateCard (which never touches SRS
 * fields); every other id in the group is deleted (tombstoned, same as any
 * other deleteCard call) so sync/other devices converge too. No-ops if
 * fewer than 2 of the given ids are found among the current cards. */
export function mergeCards(
  cardIds: string[],
  merged: Pick<NewCardInput, "front" | "reading" | "meaning" | "exampleSentence" | "context" | "cloze">,
): void {
  const idSet = new Set(cardIds);
  const group = loadCards().filter((c) => idSet.has(c.id));
  if (group.length < 2) return;

  const survivor = group.reduce((best, c) => {
    if (c.reps !== best.reps) return c.reps > best.reps ? c : best;
    if (c.intervalDays !== best.intervalDays) return c.intervalDays > best.intervalDays ? c : best;
    return new Date(c.createdAt).getTime() < new Date(best.createdAt).getTime() ? c : best;
  });

  updateCard(survivor.id, merged);
  for (const c of group) {
    if (c.id !== survivor.id) deleteCard(c.id);
  }
}

/** Bulk-replaces the entire card store with `cards` (one save, one change
 * event) — persistence only, no id lookup/merge. Only lib/sync/snapshot.ts
 * should call this; every other write path goes through addCard/updateCard/
 * deleteCard/gradeCard above so `updatedAt`/tombstones stay correct. */
export function replaceCardsForSync(cards: Card[]): void {
  saveCards(cards);
}
