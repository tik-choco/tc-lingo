// Defensive JSON parsing for LLM responses. Models occasionally wrap JSON in
// a ```json fence despite instructions not to — strip that before parsing.
// Every parse* function throws a plain Error with a short, user-facing
// message on failure; callers show it directly rather than a stack trace.
import { t } from "../i18n";

function extractJson(content: string): unknown {
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
