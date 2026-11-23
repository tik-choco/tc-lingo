// Card CRUD + defensive (de)serialization. Persistence key: tc-lingo:cards-v1.
import type { Card, CardPrioritySource, CardSource, ReviewGrade } from "../types";
import { initialSrsFields, scheduleReview } from "./srs";
import { isDueForReview, isNewCard } from "./reviewQueue";
import { loadReviewDaily, REVIEW_DAILY_STORAGE } from "./reviewDaily";
import { loadDomainJson, newId, nextUpdatedAt, saveJson, saveJsonBatch, subscribeStorage } from "./storage";
import type { JsonWrite, StorageWriteOptions } from "./storage";
import { persistDeletions } from "./sync/tombstones";
import { nextReviewActivity, REVIEW_ACTIVITY_STORAGE } from "./activityLog";

const STORAGE_NAME = "cards-v1";

export const PRIORITY_LOW = 0.2;
export const PRIORITY_NORMAL = 0.5;
export const PRIORITY_HIGH = 0.8;
export const LEECH_THRESHOLD = 4;

function clampPriority(priority: number): number {
  return Number.isFinite(priority) ? Math.max(0, Math.min(1, priority)) : PRIORITY_NORMAL;
}

export function priorityLevel(p: number): "low" | "normal" | "high" {
  return p < 0.35 ? "low" : p >= 0.65 ? "high" : "normal";
}

/** Exported so lib/sync/snapshot.ts can validate remote cards with the exact
 * same rules used to load local ones. Legacy fields may be absent here;
 * sanitizeCards supplies their defaults. */
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
    (r.priority === undefined || typeof r.priority === "number") &&
    (r.prioritySource === undefined || r.prioritySource === "default" || r.prioritySource === "auto" || r.prioritySource === "user") &&
    (r.suspended === undefined || typeof r.suspended === "boolean") &&
    (r.lastReviewedAt === undefined || r.lastReviewedAt === null || typeof r.lastReviewedAt === "string") &&
    (r.updatedAt === undefined || typeof r.updatedAt === "string")
  );
}

/** Filters + backfills a raw array into valid Cards: `language` predates
 * multi-language support on some saved cards (backfilled to "", shown
 * regardless of the active language filter, rather than dropping the card);
 * `exampleSentenceTranslation` predates the translation-reveal feature
 * (backfilled to ""); `updatedAt` predates the sync feature (backfilled to
 * `createdAt` for remote data; local loading supplies a persisted migration
 * baseline before sanitizing). Exported so
 * lib/sync/snapshot.ts can apply identical sanitization to a remote
 * snapshot's cards. */
export function sanitizeCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCard).map((c) => ({
    ...c,
    language: c.language ?? "",
    exampleSentenceTranslation: c.exampleSentenceTranslation ?? "",
    priority: clampPriority(c.priority),
    prioritySource: c.prioritySource ?? "default",
    suspended: c.suspended ?? false,
    lastReviewedAt: c.lastReviewedAt ?? null,
    updatedAt: c.updatedAt ?? c.createdAt,
  }));
}

export function loadCards(): Card[] {
  return sanitizeCards(loadDomainJson(STORAGE_NAME));
}

function saveCards(cards: Card[], options?: StorageWriteOptions): void {
  saveJson(STORAGE_NAME, cards, options);
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
  priority?: number;
  prioritySource?: CardPrioritySource;
}

export function addCard(input: NewCardInput): Card {
  const now = new Date();
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
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    priority: clampPriority(input.priority ?? PRIORITY_NORMAL),
    prioritySource: input.prioritySource ?? "default",
    suspended: false,
    lastReviewedAt: null,
    ...initialSrsFields(now),
  };
  saveCards([...loadCards(), card]);
  return card;
}

function patchCard(id: string, patch: (card: Card) => Partial<Card> | null, now = new Date()): Card | null {
  const cards = loadCards();
  const index = cards.findIndex((card) => card.id === id);
  if (index < 0) return null;
  const card = cards[index];
  const changes = patch(card);
  if (!changes) return null;
  const updated = { ...card, ...changes, updatedAt: nextUpdatedAt(card.updatedAt, now) };
  cards[index] = updated;
  try {
    saveCards(cards, { throwOnError: true });
    return updated;
  } catch (error) {
    console.warn("tc-lingo: failed to persist card update", error);
    return null;
  }
}

export function updateCard(id: string, patch: Partial<NewCardInput>): Card | null {
  return patchCard(id, () => ({
    ...(patch.front !== undefined ? { front: patch.front.trim() } : {}),
    ...(patch.reading !== undefined ? { reading: patch.reading.trim() } : {}),
    ...(patch.meaning !== undefined ? { meaning: patch.meaning.trim() } : {}),
    ...(patch.exampleSentence !== undefined ? { exampleSentence: patch.exampleSentence.trim() } : {}),
    ...(patch.exampleSentenceTranslation !== undefined
      ? { exampleSentenceTranslation: patch.exampleSentenceTranslation.trim() }
      : {}),
    ...(patch.context !== undefined ? { context: patch.context.trim() } : {}),
    ...(patch.cloze !== undefined ? { cloze: patch.cloze.trim() } : {}),
    ...(patch.priority !== undefined ? { priority: clampPriority(patch.priority) } : {}),
    ...(patch.prioritySource !== undefined ? { prioritySource: patch.prioritySource } : {}),
  }));
}

export function setCardPriority(id: string, priority: number): Card | null {
  return patchCard(id, () => ({ priority: clampPriority(priority), prioritySource: "user" }));
}

export function setAutoCardPriority(scored: Card, priority: number): Card | null {
  return patchCard(scored.id, (card) => {
    if (card.prioritySource !== "default" || !Number.isFinite(priority) ||
      card.front !== scored.front || card.meaning !== scored.meaning || card.context !== scored.context ||
      card.exampleSentence !== scored.exampleSentence || card.language !== scored.language || card.source !== scored.source) {
      return null;
    }
    return { priority: clampPriority(priority), prioritySource: "auto" };
  });
}

export function setCardSuspended(id: string, suspended: boolean): Card | null {
  return patchCard(id, () => ({ suspended }));
}

export function boostCardPriority(id: string, delta: number, options?: { dueNow?: boolean }): Card | null {
  const now = new Date();
  return patchCard(id, (card) => ({
    priority: clampPriority(card.priority + delta),
    ...(options?.dueNow && Date.parse(card.dueAt) > now.getTime() ? { dueAt: now.toISOString() } : {}),
  }), now);
}

export function deleteCard(id: string): void {
  const cards = loadCards();
  persistDeletions([{ name: STORAGE_NAME, value: cards.filter((c) => c.id !== id) }],
    [{ store: "cards", records: [{ id, updatedAt: cards.find((c) => c.id === id)?.updatedAt }] }]);
}

export function gradeCard(id: string, grade: ReviewGrade, now: Date = new Date()): Card | null {
  const cards = loadCards();
  const index = cards.findIndex((card) => card.id === id);
  if (index < 0 || cards[index].suspended) return null;
  const card = cards[index];
  const reviewed = {
    ...card,
    ...scheduleReview(card, grade, now),
    lastReviewedAt: now.toISOString(),
    updatedAt: nextUpdatedAt(card.updatedAt, now),
  };
  try {
    const updatedCards = cards.slice();
    updatedCards[index] = reviewed;
    const writes: JsonWrite[] = [{ name: STORAGE_NAME, value: updatedCards }];
    if (isNewCard(card)) {
      const daily = loadReviewDaily(now);
      writes.push({ name: REVIEW_DAILY_STORAGE, value: { ...daily, newIntroduced: daily.newIntroduced + 1 } });
    }
    writes.push({
      name: REVIEW_ACTIVITY_STORAGE,
      value: null,
      refresh: () => nextReviewActivity(cards, card.language, now),
    });
    saveJsonBatch(writes, { throwOnError: true });
    return reviewed;
  } catch (error) {
    console.warn("tc-lingo: failed to persist card review", error);
    return null;
  }
}

/** Uncapped due cards for counts and spaced re-use in other views. Matches
 * unassigned cards in every language and orders by lapses, then earliest due.
 * Review sessions use buildReviewQueue for priority ordering and limits. */
export function dueCards(now: Date = new Date(), language?: string): Card[] {
  return loadCards()
    .filter((c) => isDueForReview(c, now, language))
    .sort((a, b) => b.lapses - a.lapses || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

/** Merges `cardIds` (2 or more) into a single card, for CardsView's LLM-
 * assisted "類似カードを整理" cleanup tool (see lib/llm.ts requestCardMerges).
 * The survivor is whichever of the given cards has made the most learning
 * progress — highest `reps`, then highest `intervalDays`, then oldest
 * `createdAt` to break remaining ties deterministically — so consolidating
 * near-duplicate cards doesn't reset SRS progress back to new. Its content
 * fields are replaced with `merged` and it gets the group's highest priority.
 * Every other id in the group is deleted (tombstoned, same as any
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

  const highest = group.reduce((best, card) => card.priority > best.priority ? card : best, survivor);
  const prioritySource = group.some((card) => card.prioritySource === "user") ? "user" : highest.prioritySource;
  if (!updateCard(survivor.id, { ...merged, priority: highest.priority, prioritySource })) return;
  for (const c of group) {
    if (c.id !== survivor.id) deleteCard(c.id);
  }
}

/** Bulk-replaces the entire card store, without generating revisions or tombstones. */
export function replaceCardsForSync(cards: Card[], options?: StorageWriteOptions): void {
  saveCards(cards, options);
}
