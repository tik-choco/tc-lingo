// Reading passage CRUD + generation (読む tab — the comprehensible-input step
// of the core loop, see CLAUDE.md's design brief). Persistence key:
// tc-lingo:passages-v1. Same defensive-sanitizer/CRUD shape as cards.ts/
// topics.ts: malformed/foreign entries are dropped, never thrown on.
import { t } from "../i18n";
import type { LlmConnection } from "./llmConnection";
import { chatJson } from "./llm";
import { levelInstruction } from "./level";
import { readingAid } from "./languages";
import { extractJson } from "./parse";
import type { ReadingPassage } from "../types";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";
import { recordTombstone } from "./sync/tombstones";

const STORAGE_NAME = "passages-v1";

/** Oldest passages fall off once a language's collection grows past this —
 * comprehensible-input passages are meant to be read once or twice and
 * moved on from, not accumulated indefinitely like cards. */
const MAX_PASSAGES = 30;

/** `reading` is optional here to accept passages saved before reading aids
 * existed — loadPassages back-fills it to "" below, same pattern as
 * topics.ts's loadAttempts backfilling retryCorrected/retryReasons. */
function isSentence(value: unknown): value is { text: string; translation: string; reading?: string } {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.text === "string" &&
    typeof r.translation === "string" &&
    (r.reading === undefined || typeof r.reading === "string")
  );
}

/** Exported so lib/sync/snapshot.ts can validate remote passages with the
 * exact same rules used to load local ones. `updatedAt` is optional here to
 * accept passages saved before the sync feature existed — see
 * sanitizePassages. */
export function isReadingPassage(value: unknown): value is ReadingPassage {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.language === "string" &&
    typeof r.title === "string" &&
    Array.isArray(r.sentences) &&
    r.sentences.every(isSentence) &&
    Array.isArray(r.reviewWords) &&
    r.reviewWords.every((w) => typeof w === "string") &&
    typeof r.question === "string" &&
    typeof r.questionAnswer === "string" &&
    typeof r.createdAt === "string" &&
    (r.updatedAt === undefined || typeof r.updatedAt === "string")
  );
}

/** Filters + backfills a raw array into valid ReadingPassages: per-sentence
 * `reading` predates the reading-aid feature (backfilled to ""); `updatedAt`
 * predates the sync feature (backfilled to `createdAt`, same rationale as
 * cards.ts's sanitizeCards). Exported so lib/sync/snapshot.ts can apply
 * identical sanitization to a remote snapshot's passages. */
export function sanitizePassages(raw: unknown): ReadingPassage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isReadingPassage).map((p) => ({
    ...p,
    sentences: p.sentences.map((s) => ({ ...s, reading: s.reading ?? "" })),
    updatedAt: p.updatedAt ?? p.createdAt,
  }));
}

/** `language`, when given, also matches passages saved with "" (unassigned)
 * so they aren't orphaned out of every filtered view — same convention as
 * Card.language (see types.ts). */
export function loadPassages(language?: string): ReadingPassage[] {
  const passages = sanitizePassages(loadJson<unknown[]>(STORAGE_NAME, []));
  return language ? passages.filter((p) => p.language === language || p.language === "") : passages;
}

function savePassages(passages: ReadingPassage[]): void {
  saveJson(STORAGE_NAME, passages);
}

export function subscribePassages(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export interface NewPassageInput {
  language: string;
  title: string;
  sentences: { text: string; translation: string; reading: string }[];
  reviewWords?: string[];
  question?: string;
  questionAnswer?: string;
}

/** Newest-first; capped at MAX_PASSAGES so the list doesn't grow forever. */
export function addPassage(input: NewPassageInput): ReadingPassage {
  const now = new Date().toISOString();
  const passage: ReadingPassage = {
    id: newId(),
    language: input.language,
    title: input.title.trim(),
    sentences: input.sentences,
    reviewWords: input.reviewWords ?? [],
    question: input.question ?? "",
    questionAnswer: input.questionAnswer ?? "",
    createdAt: now,
    updatedAt: now,
  };
  savePassages([passage, ...loadPassages()].slice(0, MAX_PASSAGES));
  return passage;
}

export function deletePassage(id: string): void {
  savePassages(loadPassages().filter((p) => p.id !== id));
  recordTombstone("passages", id);
}

/** Bulk-replaces the entire passage store with `passages` (one save, one
 * change event) — persistence only, no id lookup/merge and no MAX_PASSAGES
 * capping (that's addPassage's business logic, not the raw save path). Only
 * lib/sync/snapshot.ts should call this; every other write path goes through
 * addPassage/deletePassage above so `updatedAt`/tombstones stay correct. */
export function replacePassagesForSync(passages: ReadingPassage[]): void {
  savePassages(passages);
}

interface GeneratedPassage {
  title: string;
  sentences: { text: string; translation: string; reading: string }[];
  usedReviewWords: string[];
  question: string;
  questionAnswer: string;
}

/** Defensive parse for requestReadingPassage's one-shot JSON response, same
 * style as lib/parse.ts's parse* helpers (own function here per that file's
 * header comment inviting sibling LLM-call modules to do this locally).
 * Tolerates a missing/non-string "reading" (languages without a reading aid
 * never ask the LLM for one — see requestReadingPassage). */
function parseGeneratedPassage(content: string): GeneratedPassage {
  const parsed = extractJson(content) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const sentences = Array.isArray(parsed.sentences)
    ? parsed.sentences
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          text: typeof item.text === "string" ? item.text : "",
          translation: typeof item.translation === "string" ? item.translation : "",
          reading: typeof item.reading === "string" ? item.reading : "",
        }))
        .filter((s) => s.text)
    : [];
  const usedReviewWords = Array.isArray(parsed.usedReviewWords)
    ? parsed.usedReviewWords.filter((w): w is string => typeof w === "string")
    : [];
  const question = typeof parsed.question === "string" ? parsed.question : "";
  const questionAnswer = typeof parsed.questionAnswer === "string" ? parsed.questionAnswer : "";
  if (!title || sentences.length === 0) throw new Error(t("reading-error-no-passage"));
  return { title, sentences, usedReviewWords, question, questionAnswer };
}

/** Generates one short comprehensible-input ("i+1") passage in
 * targetLanguage, optionally weaving in a handful of due-for-review card
 * fronts (spaced re-use, same rationale as requestTopicSuggestion's
 * reviewWords), and saves it via addPassage. */
export async function requestReadingPassage(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  reviewWords: string[];
  recentTitles: string[];
  topicRequest?: string;
}): Promise<ReadingPassage> {
  // Reading aids (e.g. pinyin) are only requested for languages that have
  // one (see lib/languages.ts readingAid) — omitted from the prompt entirely
  // otherwise, rather than asking for a field that's always thrown away.
  const aid = readingAid(params.targetLanguage);
  const sentenceFieldsDescription = aid
    ? `"text" (one sentence in ${params.targetLanguage}), "translation" (that sentence's translation in ${params.nativeLanguage}), and "reading" (${aid.llmInstruction} for that sentence)`
    : `"text" (one sentence in ${params.targetLanguage}) and "translation" (that sentence's translation in ${params.nativeLanguage})`;
  // Same optional free-text steer as requestTopicSuggestion's topicRequest —
  // takes priority over recentTitles avoidance when given.
  const topicRequestInstruction =
    params.topicRequest && params.topicRequest.trim()
      ? ` The learner described what kind of topic they want (topicRequest): "${params.topicRequest.trim()}". Follow this request when choosing the passage's topic — it takes priority over avoiding recentTitles — but the passage must still be natural and easy to follow.`
      : "";
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's comprehensible-input passage generator. Write one short passage in ${params.targetLanguage} for a learner whose native language is ${params.nativeLanguage} and who is slightly below native fluency ("i+1": simple, natural, everyday narrative or opinion piece). The passage should be 6-10 short sentences, natural and easy to follow, not a contrived grammar drill. The learner is due to review these words/phrases (reviewWords): weave in 1-3 of them naturally if they genuinely fit the passage; never force a word in if it doesn't fit — a good, natural passage beats a forced vocabulary match, and it's fine to use none of them. Avoid topics already covered in recentTitles.${topicRequestInstruction} Also write one short comprehension question in ${params.targetLanguage} about the passage, and its expected answer in ${params.targetLanguage}. Return only JSON with exactly these keys: "title" (a short label in ${params.nativeLanguage}), "sentences" (an array of objects, each with ${sentenceFieldsDescription}), "usedReviewWords" (array of strings: which of the given reviewWords were actually used, possibly empty), "question" (the comprehension question, in ${params.targetLanguage}), "questionAnswer" (its expected answer, in ${params.targetLanguage}).${levelInstruction(params.targetLanguage)}`,
    { reviewWords: params.reviewWords, recentTitles: params.recentTitles, topicRequest: params.topicRequest ?? "" },
  );
  const generated = parseGeneratedPassage(content);
  return addPassage({
    language: params.targetLanguage,
    title: generated.title,
    // When the target language has no reading aid, force "" even if the
    // model stuck a stray "reading" in anyway — it was never asked for one.
    sentences: aid ? generated.sentences : generated.sentences.map((s) => ({ ...s, reading: "" })),
    reviewWords: generated.usedReviewWords,
    question: generated.question,
    questionAnswer: generated.questionAnswer,
  });
}
