// Reading passage CRUD + generation (読む tab — the comprehensible-input step
// of the core loop, see CLAUDE.md's design brief). Persistence key:
// tc-lingo:passages-v1. Same defensive-sanitizer/CRUD shape as cards.ts/
// topics.ts: malformed/foreign entries are dropped, never thrown on.
import { t } from "../i18n";
import type { LlmConnection } from "./llmConnection";
import { chatJson } from "./llm";
import { levelInstruction } from "./level";
import { extractJson } from "./parse";
import type { ReadingPassage } from "../types";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";

const STORAGE_NAME = "passages-v1";

/** Oldest passages fall off once a language's collection grows past this —
 * comprehensible-input passages are meant to be read once or twice and
 * moved on from, not accumulated indefinitely like cards. */
const MAX_PASSAGES = 30;

function isSentence(value: unknown): value is { text: string; translation: string } {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.text === "string" && typeof r.translation === "string";
}

function isReadingPassage(value: unknown): value is ReadingPassage {
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
    typeof r.createdAt === "string"
  );
}

/** `language`, when given, also matches passages saved with "" (unassigned)
 * so they aren't orphaned out of every filtered view — same convention as
 * Card.language (see types.ts). */
export function loadPassages(language?: string): ReadingPassage[] {
  const raw = loadJson<unknown[]>(STORAGE_NAME, []);
  const passages = Array.isArray(raw) ? raw.filter(isReadingPassage) : [];
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
  sentences: { text: string; translation: string }[];
  reviewWords?: string[];
  question?: string;
  questionAnswer?: string;
}

/** Newest-first; capped at MAX_PASSAGES so the list doesn't grow forever. */
export function addPassage(input: NewPassageInput): ReadingPassage {
  const passage: ReadingPassage = {
    id: newId(),
    language: input.language,
    title: input.title.trim(),
    sentences: input.sentences,
    reviewWords: input.reviewWords ?? [],
    question: input.question ?? "",
    questionAnswer: input.questionAnswer ?? "",
    createdAt: new Date().toISOString(),
  };
  savePassages([passage, ...loadPassages()].slice(0, MAX_PASSAGES));
  return passage;
}

export function deletePassage(id: string): void {
  savePassages(loadPassages().filter((p) => p.id !== id));
}

interface GeneratedPassage {
  title: string;
  sentences: { text: string; translation: string }[];
  usedReviewWords: string[];
  question: string;
  questionAnswer: string;
}

/** Defensive parse for requestReadingPassage's one-shot JSON response, same
 * style as lib/parse.ts's parse* helpers (own function here per that file's
 * header comment inviting sibling LLM-call modules to do this locally). */
function parseGeneratedPassage(content: string): GeneratedPassage {
  const parsed = extractJson(content) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const sentences = Array.isArray(parsed.sentences)
    ? parsed.sentences
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          text: typeof item.text === "string" ? item.text : "",
          translation: typeof item.translation === "string" ? item.translation : "",
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
}): Promise<ReadingPassage> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's comprehensible-input passage generator. Write one short passage in ${params.targetLanguage} for a learner whose native language is ${params.nativeLanguage} and who is slightly below native fluency ("i+1": simple, natural, everyday narrative or opinion piece). The passage should be 6-10 short sentences, natural and easy to follow, not a contrived grammar drill. The learner is due to review these words/phrases (reviewWords): weave in 1-3 of them naturally if they genuinely fit the passage; never force a word in if it doesn't fit — a good, natural passage beats a forced vocabulary match, and it's fine to use none of them. Avoid topics already covered in recentTitles. Also write one short comprehension question in ${params.targetLanguage} about the passage, and its expected answer in ${params.targetLanguage}. Return only JSON with exactly these keys: "title" (a short label in ${params.nativeLanguage}), "sentences" (an array of objects, each with "text" (one sentence in ${params.targetLanguage}) and "translation" (that sentence's translation in ${params.nativeLanguage})), "usedReviewWords" (array of strings: which of the given reviewWords were actually used, possibly empty), "question" (the comprehension question, in ${params.targetLanguage}), "questionAnswer" (its expected answer, in ${params.targetLanguage}).${levelInstruction(params.targetLanguage)}`,
    { reviewWords: params.reviewWords, recentTitles: params.recentTitles },
  );
  const generated = parseGeneratedPassage(content);
  return addPassage({
    language: params.targetLanguage,
    title: generated.title,
    sentences: generated.sentences,
    reviewWords: generated.usedReviewWords,
    question: generated.question,
    questionAnswer: generated.questionAnswer,
  });
}
