// Defensive JSON parsing for LLM responses. Models occasionally wrap JSON in
// a ```json fence despite instructions not to — strip that before parsing.
// Every parse* function throws a plain Error with a short, user-facing
// message on failure; callers show it directly rather than a stack trace.
import { t } from "../i18n";

/** Exported for the sibling parse helpers in lib/reading.ts,
 * lib/conversation.ts, and lib/grammar.ts. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(t("error-parse-json"));
  }
}

export interface FeedbackResult {
  corrected: string;
  /** Always-visible reading aid for `corrected` (e.g. pinyin — see
   * lib/languages.ts readingAid); "" when the target language has no aid. */
  correctedReading: string;
  /** Native-language translation of `corrected`; "" when no translation. */
  correctedTranslation: string;
  reasons: string;
  retryPrompt: string;
  /** Reading aid for `retryPrompt`; "" when no aid. */
  retryPromptReading: string;
  /** Native-language translation of `retryPrompt`; "" when no translation. */
  retryPromptTranslation: string;
}

export function parseFeedback(content: string): FeedbackResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const corrected = typeof parsed.corrected === "string" ? parsed.corrected : "";
  const correctedReading = typeof parsed.correctedReading === "string" ? parsed.correctedReading : "";
  const correctedTranslation = typeof parsed.correctedTranslation === "string" ? parsed.correctedTranslation : "";
  const reasons = typeof parsed.reasons === "string" ? parsed.reasons : "";
  const retryPrompt = typeof parsed.retryPrompt === "string" ? parsed.retryPrompt : "";
  const retryPromptReading = typeof parsed.retryPromptReading === "string" ? parsed.retryPromptReading : "";
  const retryPromptTranslation = typeof parsed.retryPromptTranslation === "string" ? parsed.retryPromptTranslation : "";
  if (!corrected) throw new Error(t("error-missing-correction"));
  return { corrected, correctedReading, correctedTranslation, reasons, retryPrompt, retryPromptReading, retryPromptTranslation };
}

export interface RetryFeedbackResult {
  corrected: string;
  /** Reading aid for `corrected`; "" when no aid. */
  correctedReading: string;
  /** Native-language translation of `corrected`; "" when no translation. */
  correctedTranslation: string;
  reasons: string;
}

/** Same shape as FeedbackResult minus retryPrompt — used for the "check my
 * answer" pass over a follow-up retry answer (requestRetryFeedback). */
export function parseRetryFeedback(content: string): RetryFeedbackResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const corrected = typeof parsed.corrected === "string" ? parsed.corrected : "";
  const correctedReading = typeof parsed.correctedReading === "string" ? parsed.correctedReading : "";
  const correctedTranslation = typeof parsed.correctedTranslation === "string" ? parsed.correctedTranslation : "";
  const reasons = typeof parsed.reasons === "string" ? parsed.reasons : "";
  if (!corrected) throw new Error(t("error-missing-correction"));
  return { corrected, correctedReading, correctedTranslation, reasons };
}

export interface TopicSuggestion {
  title: string;
  prompt: string;
  /** Native-language translation of `prompt`; "" when no translation. */
  promptTranslation: string;
}

export function parseTopicSuggestion(content: string): TopicSuggestion {
  const parsed = extractJson(content) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  const promptTranslation = typeof parsed.promptTranslation === "string" ? parsed.promptTranslation : "";
  if (!title || !prompt) throw new Error(t("error-missing-topic"));
  return { title, prompt, promptTranslation };
}

export interface TopicFanOutPlan {
  theme: string;
  targets: string[];
}

/** Defensive: an empty/unparsable plan falls back to every candidate rather
 * than silently dropping languages the learner is studying. */
export function parseTopicFanOutPlan(content: string, candidateLanguages: string[]): TopicFanOutPlan {
  try {
    const parsed = extractJson(content) as Record<string, unknown>;
    const theme = typeof parsed.theme === "string" ? parsed.theme.trim() : "";
    const targets = Array.isArray(parsed.targets)
      ? parsed.targets.filter((l): l is string => typeof l === "string" && candidateLanguages.includes(l))
      : [];
    return { theme, targets: targets.length ? targets : candidateLanguages };
  } catch {
    return { theme: "", targets: candidateLanguages };
  }
}

/** "near" covers a right-word-wrong-form recall (tense, plural, conjugation,
 * politeness level, minor spelling slip) — same three-way shape as
 * lib/srs.ts's AnswerJudgement, so callers can drop it straight into the
 * existing correct/near/wrong grading and UI. */
export type AnswerVerdictKind = "correct" | "near" | "wrong";

export interface AnswerVerdict {
  verdict: AnswerVerdictKind;
  note: string;
  /** The displayed cloze sentence rewritten so the LEARNER's own typed
   * expression is used correctly (fixed inflection/collocation/word order),
   * in the target language — constructive correction even for a "wrong"
   * verdict, same spirit as the practice tab's `corrected` text. "" when
   * there's no cloze sentence to rewrite, or the typed answer isn't a usable
   * expression attempt (gibberish/unrelated) to build a rewrite from. */
  rewrite: string;
}

/** For the review tab's LLM second-opinion judge (llm.ts judgeReviewAnswer):
 * a missing/invalid "verdict" is a parse failure — the caller catches and
 * falls back to the strict string judgement — while a missing note/rewrite is
 * just "". */
export function parseAnswerVerdict(content: string): AnswerVerdict {
  const parsed = extractJson(content) as Record<string, unknown>;
  if (parsed.verdict !== "correct" && parsed.verdict !== "near" && parsed.verdict !== "wrong") {
    throw new Error(t("error-parse-json"));
  }
  return {
    verdict: parsed.verdict,
    note: typeof parsed.note === "string" ? parsed.note : "",
    rewrite: typeof parsed.rewrite === "string" ? parsed.rewrite : "",
  };
}

/** lib/llm.ts's requestCardConsistencyCheck: whether a card's `cloze` blank,
 * filled with `front`, actually reproduces `exampleSentence` — and if not,
 * a corrected `front`/`cloze` pair that does. When `consistent` is true,
 * `front`/`cloze` just echo the input (callers should ignore them). */
export interface CardConsistencyResult {
  consistent: boolean;
  front: string;
  cloze: string;
}

/** A missing/non-boolean "consistent" is a parse failure — the caller
 * catches and treats the card as already consistent (best-effort, never
 * worth surfacing a failure for a background QA pass). */
export function parseCardConsistencyResult(content: string): CardConsistencyResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  if (typeof parsed.consistent !== "boolean") throw new Error(t("error-parse-json"));
  return {
    consistent: parsed.consistent,
    front: typeof parsed.front === "string" ? parsed.front : "",
    cloze: typeof parsed.cloze === "string" ? parsed.cloze : "",
  };
}

export interface CardCandidate {
  front: string;
  reading: string;
  meaning: string;
  exampleSentence: string;
  /** Native-language translation of exampleSentence, revealed on demand in
   * the UI (see types.ts's Card.exampleSentenceTranslation); "" when the
   * model didn't provide one (e.g. exampleSentence itself is empty). */
  exampleSentenceTranslation: string;
  context: string;
  cloze: string;
}

export function parseCardCandidates(content: string): CardCandidate[] {
  const parsed = extractJson(content);
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Record<string, unknown>)?.cards) ? (parsed as Record<string, unknown>).cards : null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      front: typeof item.front === "string" ? item.front : "",
      reading: typeof item.reading === "string" ? item.reading : "",
      meaning: typeof item.meaning === "string" ? item.meaning : "",
      exampleSentence: typeof item.exampleSentence === "string" ? item.exampleSentence : "",
      exampleSentenceTranslation: typeof item.exampleSentenceTranslation === "string" ? item.exampleSentenceTranslation : "",
      context: typeof item.context === "string" ? item.context : "",
      cloze: typeof item.cloze === "string" ? item.cloze : "",
    }))
    .filter((c) => c.front && c.meaning);
}

/** lib/llm.ts's requestClozeVariation: the model returns its new sentence
 * plus which contiguous span of it fills the blank ("answer"), rather than a
 * pre-blanked cloze — `cloze` is then built deterministically by blanking
 * that span out of `sentence`, so cloze/answer alignment can never drift the
 * way a model-authored cloze string could. A missing/empty "sentence" or
 * "answer", or an "answer" that doesn't actually occur in "sentence", is a
 * parse failure — the caller catches and falls back to the card's own stored
 * cloze rather than surfacing one. An "answer" occurring more than once is
 * also a failure: blanking only the first match would leave the answer
 * visible elsewhere in the sentence (or blank a substring inside an
 * unrelated word), so an ambiguous match is dropped, not guessed at.
 * `translation` (a native-language translation of the new "sentence", for
 * ReviewView's question-phase translation toggle) is optional — "" when the
 * model omitted it, never a parse failure on its own. */
export function parseClozeVariation(content: string): { cloze: string; answer: string; translation: string } {
  const parsed = extractJson(content) as Record<string, unknown>;
  const sentence = typeof parsed.sentence === "string" ? parsed.sentence.trim() : "";
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
  if (!sentence || !answer || sentence.indexOf(answer) === -1 || sentence.indexOf(answer) !== sentence.lastIndexOf(answer)) {
    throw new Error(t("error-parse-json"));
  }
  return { cloze: sentence.replace(answer, "___"), answer, translation };
}

export interface CardMergeGroup {
  cardIds: string[];
  merged: { front: string; reading: string; meaning: string; exampleSentence: string; context: string; cloze: string };
  reason: string;
}

/** For lib/llm.ts's requestCardMerges (CardsView's "similar cards" cleanup
 * tool): defensively resolves the model's proposed merge groups against the
 * actual card ids sent in the request. `validIds` filters out any
 * hallucinated id; a group left with fewer than 2 known ids can't merge
 * anything, so it's dropped. If the model reuses the same card id across
 * multiple groups (which would make merging ambiguous), only its first
 * group keeps that id — later groups have it stripped, and may themselves
 * end up dropped below the 2-id floor. */
export function parseCardMergeGroups(content: string, validIds: Set<string>): CardMergeGroup[] {
  const parsed = extractJson(content);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.groups)
      ? (parsed as Record<string, unknown>).groups
      : null;
  if (!Array.isArray(list)) return [];

  const claimed = new Set<string>();
  const groups: CardMergeGroup[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const rawIds = Array.isArray(r.cardIds) ? r.cardIds.filter((id): id is string => typeof id === "string") : [];
    const cardIds = rawIds.filter((id) => validIds.has(id) && !claimed.has(id));
    if (cardIds.length < 2) continue;

    const m = (typeof r.merged === "object" && r.merged !== null ? r.merged : {}) as Record<string, unknown>;
    const front = typeof m.front === "string" ? m.front : "";
    const meaning = typeof m.meaning === "string" ? m.meaning : "";
    if (!front || !meaning) continue;

    cardIds.forEach((id) => claimed.add(id));
    groups.push({
      cardIds,
      merged: {
        front,
        meaning,
        reading: typeof m.reading === "string" ? m.reading : "",
        exampleSentence: typeof m.exampleSentence === "string" ? m.exampleSentence : "",
        context: typeof m.context === "string" ? m.context : "",
        cloze: typeof m.cloze === "string" ? m.cloze : "",
      },
      reason: typeof r.reason === "string" ? r.reason : "",
    });
  }
  return groups;
}

export interface SentenceCardCandidate {
  sentence: string;
  reading: string;
  translation: string;
}

/** For lib/sentenceCards.ts's "save the corrected sentence as-is" flow: the
 * model is only asked for reading/translation, not to rewrite the sentence,
 * but this stays as defensive as parseCardCandidates in case it echoes the
 * input back reshaped anyway. */
export function parseSentenceCards(content: string): SentenceCardCandidate[] {
  const parsed = extractJson(content);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.sentences)
      ? (parsed as Record<string, unknown>).sentences
      : null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      sentence: typeof item.sentence === "string" ? item.sentence : "",
      reading: typeof item.reading === "string" ? item.reading : "",
      translation: typeof item.translation === "string" ? item.translation : "",
    }))
    .filter((c) => c.sentence && c.translation);
}
