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
  reasons: string;
  retryPrompt: string;
}

export function parseFeedback(content: string): FeedbackResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const corrected = typeof parsed.corrected === "string" ? parsed.corrected : "";
  const reasons = typeof parsed.reasons === "string" ? parsed.reasons : "";
  const retryPrompt = typeof parsed.retryPrompt === "string" ? parsed.retryPrompt : "";
  if (!corrected) throw new Error(t("error-missing-correction"));
  return { corrected, reasons, retryPrompt };
}

export interface RetryFeedbackResult {
  corrected: string;
  reasons: string;
}

/** Same shape as FeedbackResult minus retryPrompt — used for the "check my
 * answer" pass over a follow-up retry answer (requestRetryFeedback). */
export function parseRetryFeedback(content: string): RetryFeedbackResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const corrected = typeof parsed.corrected === "string" ? parsed.corrected : "";
  const reasons = typeof parsed.reasons === "string" ? parsed.reasons : "";
  if (!corrected) throw new Error(t("error-missing-correction"));
  return { corrected, reasons };
}

export interface TopicSuggestion {
  title: string;
  prompt: string;
}

export function parseTopicSuggestion(content: string): TopicSuggestion {
  const parsed = extractJson(content) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  if (!title || !prompt) throw new Error(t("error-missing-topic"));
  return { title, prompt };
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

export interface AnswerVerdict {
  acceptable: boolean;
  note: string;
}

/** For the review tab's LLM second-opinion judge (llm.ts judgeReviewAnswer):
 * a missing/non-boolean "acceptable" is a parse failure — the caller catches
 * and falls back to the strict string judgement — while a missing note is
 * just "". */
export function parseAnswerVerdict(content: string): AnswerVerdict {
  const parsed = extractJson(content) as Record<string, unknown>;
  if (typeof parsed.acceptable !== "boolean") throw new Error(t("error-parse-json"));
  return { acceptable: parsed.acceptable, note: typeof parsed.note === "string" ? parsed.note : "" };
}

export interface CardCandidate {
  front: string;
  reading: string;
  meaning: string;
  exampleSentence: string;
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
      context: typeof item.context === "string" ? item.context : "",
      cloze: typeof item.cloze === "string" ? item.cloze : "",
    }))
    .filter((c) => c.front && c.meaning);
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
