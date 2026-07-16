// Card CRUD + defensive (de)serialization. Persistence key: tc-lingo:cards-v1.
import type { Card, CardSource, ReviewGrade } from "../types";
import { initialSrsFields, scheduleReview, isDue } from "./srs";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";

const STORAGE_NAME = "cards-v1";

function isCard(value: unknown): value is Card {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.front === "string" &&
    typeof r.reading === "string" &&
    typeof r.meaning === "string" &&
    typeof r.exampleSentence === "string" &&
    typeof r.context === "string" &&
    typeof r.cloze === "string" &&
    (r.source === "manual" || r.source === "mistake") &&
    (r.sourceTopicId === null || typeof r.sourceTopicId === "string") &&
    (r.language === undefined || typeof r.language === "string") &&
    typeof r.createdAt === "string" &&
    typeof r.dueAt === "string" &&
    typeof r.intervalDays === "number" &&
    typeof r.easeFactor === "number" &&
    typeof r.reps === "number" &&
    typeof r.lapses === "number"
  );
}

export function loadCards(): Card[] {
  const raw = loadJson<unknown[]>(STORAGE_NAME, []);
  if (!Array.isArray(raw)) return [];
  // `language` predates multi-language support on some saved cards; treat
  // missing as "" (shown regardless of the active language filter) rather
  // than dropping the card.
  return raw.filter(isCard).map((c) => ({ ...c, language: c.language ?? "" }));
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
  context?: string;
  cloze?: string;
  source?: CardSource;
  sourceTopicId?: string | null;
  /** Defaults to "" (unassigned, visible under every language filter) so
   * existing call sites that don't yet pass a language keep working. */
  language?: string;
}

export function addCard(input: NewCardInput): Card {
  const card: Card = {
    id: newId(),
    front: input.front.trim(),
    reading: (input.reading ?? "").trim(),
    meaning: input.meaning.trim(),
    exampleSentence: (input.exampleSentence ?? "").trim(),
    context: (input.context ?? "").trim(),
    cloze: (input.cloze ?? "").trim(),
    source: input.source ?? "manual",
    sourceTopicId: input.sourceTopicId ?? null,
    language: input.language ?? "",
    createdAt: new Date().toISOString(),
    ...initialSrsFields(),
  };
  saveCards([...loadCards(), card]);
  return card;
}

export function updateCard(id: string, patch: Partial<NewCardInput>): void {
  const cards = loadCards().map((c) =>
    c.id === id
      ? {
          ...c,
          ...(patch.front !== undefined ? { front: patch.front.trim() } : {}),
          ...(patch.reading !== undefined ? { reading: patch.reading.trim() } : {}),
          ...(patch.meaning !== undefined ? { meaning: patch.meaning.trim() } : {}),
          ...(patch.exampleSentence !== undefined ? { exampleSentence: patch.exampleSentence.trim() } : {}),
          ...(patch.context !== undefined ? { context: patch.context.trim() } : {}),
          ...(patch.cloze !== undefined ? { cloze: patch.cloze.trim() } : {}),
        }
      : c,
  );
  saveCards(cards);
}

export function deleteCard(id: string): void {
  saveCards(loadCards().filter((c) => c.id !== id));
}

export function gradeCard(id: string, grade: ReviewGrade, now: Date = new Date()): void {
  const cards = loadCards().map((c) => (c.id === id ? { ...c, ...scheduleReview(c, grade, now) } : c));
  saveCards(cards);
}

/** `language`, when given, also matches cards saved with "" (unassigned) so
 * pre-multi-language cards don't get orphaned out of every filtered queue. */
export function dueCards(now: Date = new Date(), language?: string): Card[] {
  return loadCards()
    .filter((c) => isDue(c, now) && (!language || c.language === language || c.language === ""))
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}
