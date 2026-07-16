// LLM calls: structured output+correction feedback, topic suggestion, and
// mistake→flashcard extraction. All three are one-shot JSON requests
// (stream: false semantics achieved by ignoring onDelta) against whichever
// shared preset the user has configured — see lib/llmConfig.ts and
// lib/settings.ts. Direct HTTP only; no P2P Network transport (unlike some
// sibling apps) since that would need vendoring the mistlib WASM build,
// which this app's MVP scope doesn't need.
import { streamChatCompletion } from "@tik-choco/mistai";
import type { ResolvedLlmTargetV1 } from "./llmConfig";
import { parseCardCandidates, parseFeedback, parseTopicFanOutPlan, parseTopicSuggestion } from "./parse";
import type { CardCandidate, FeedbackResult, TopicFanOutPlan, TopicSuggestion } from "./parse";

function chatConfig(target: ResolvedLlmTargetV1) {
  return {
    baseUrl: target.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: target.apiKey,
    model: target.model,
    temperature: target.temperature,
    reasoningEffort: target.reasoningEffort,
  };
}

async function chatJson(target: ResolvedLlmTargetV1, systemPrompt: string, userPayload: unknown): Promise<string> {
  const content = await streamChatCompletion(chatConfig(target), [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);
  if (!content.trim()) throw new Error("AIから応答がありませんでした。");
  return content;
}

/** Minimal round-trip used by the onboarding wizard's "接続テスト" button —
 * confirms the endpoint/key/model actually work before the learner leaves
 * the setup step, independent of any of this app's JSON-shaped prompts. */
export async function testConnection(target: { baseUrl: string; apiKey: string; model: string }): Promise<void> {
  const content = await streamChatCompletion(
    { baseUrl: target.baseUrl.trim().replace(/\/+$/, ""), apiKey: target.apiKey, model: target.model },
    [{ role: "user", content: "接続テストです。「OK」とだけ返してください。" }],
  );
  if (!content.trim()) throw new Error("応答が空でした。");
}

export async function requestFeedback(params: {
  target: ResolvedLlmTargetV1;
  targetLanguage: string;
  nativeLanguage: string;
  topicPrompt: string;
  userText: string;
}): Promise<FeedbackResult> {
  const content = await chatJson(
    params.target,
    `You are TC Lingo's writing/speaking coach. The learner is producing output in ${params.targetLanguage}; explanations must be written in ${params.nativeLanguage}. Given a topic prompt and the learner's attempt, correct their text naturally (fix grammar, word choice, and unnatural phrasing while preserving their intended meaning), explain the key reasons for each correction in ${params.nativeLanguage} (concise, bullet-like sentences), and propose one short follow-up question or variation in ${params.targetLanguage} that lets the learner immediately retry using the corrected pattern. Return only JSON with exactly these keys: "corrected" (the corrected ${params.targetLanguage} text), "reasons" (explanation in ${params.nativeLanguage}), "retryPrompt" (a short follow-up prompt in ${params.targetLanguage}). Do not restate the original text.`,
    { topicPrompt: params.topicPrompt, learnerText: params.userText },
  );
  return parseFeedback(content);
}

export async function requestTopicSuggestion(params: {
  target: ResolvedLlmTargetV1;
  targetLanguage: string;
  nativeLanguage: string;
  recentTitles: string[];
  /** Optional shared theme (from planTopicFanOut) to loosely build on, so
   * topics generated together across several languages feel coordinated
   * rather than random. Omit for a normal single-language suggestion. */
  theme?: string;
}): Promise<TopicSuggestion> {
  const themeHint = params.theme
    ? ` Loosely build today's topic around this shared theme if it fits naturally: "${params.theme}". Don't force it — a good, natural topic beats a forced match.`
    : "";
  const content = await chatJson(
    params.target,
    `You are TC Lingo's topic generator. Suggest one short, concrete daily speaking/writing topic for a learner of ${params.targetLanguage} (whose native language is ${params.nativeLanguage}), answerable in about 60-90 seconds or a short paragraph. Prefer everyday, personal, or opinion topics over abstract ones. Avoid repeating any topic in recentTitles.${themeHint} Return only JSON with exactly these keys: "title" (a short label in ${params.nativeLanguage}), "prompt" (the actual instruction/question, written in ${params.targetLanguage}).`,
    { recentTitles: params.recentTitles },
  );
  return parseTopicSuggestion(content);
}

/** Orchestrator step for studying several languages at once: given each
 * target language's recent topic titles, picks one shared theme (so topics
 * generated together feel coordinated) and which candidate languages are
 * actually worth dispatching a fresh topic to this round. The caller then
 * fans out one requestTopicSuggestion (worker) call per planned target, run
 * in parallel — same orchestrator-plans/worker-executes shape as
 * tc-translate's lib/simultaneousTranslate.ts planTranslationFanOut. */
export async function planTopicFanOut(params: {
  target: ResolvedLlmTargetV1;
  nativeLanguage: string;
  candidateLanguages: string[];
  recentTitlesByLanguage: Record<string, string[]>;
}): Promise<TopicFanOutPlan> {
  if (params.candidateLanguages.length <= 1) {
    return { theme: "", targets: params.candidateLanguages };
  }
  const content = await chatJson(
    params.target,
    `You are the orchestrator for TC Lingo's multi-language practice planner. The learner studies several languages at once: ${params.candidateLanguages.join(", ")} (native language: ${params.nativeLanguage}). Given each language's recently used topic titles (recentTitlesByLanguage), pick one short shared theme, written in ${params.nativeLanguage}, that today's topics across all these languages can loosely share, and decide which of the candidate languages should get a freshly generated topic dispatched to a topic-generation worker this round — normally all of them. Return only JSON: {"theme": string, "targets": string[]}. "targets" must be a subset of candidateLanguages, in their original order.`,
    { candidateLanguages: params.candidateLanguages, recentTitlesByLanguage: params.recentTitlesByLanguage },
  );
  return parseTopicFanOutPlan(content, params.candidateLanguages);
}

export async function requestMistakeCards(params: {
  target: ResolvedLlmTargetV1;
  targetLanguage: string;
  nativeLanguage: string;
  original: string;
  corrected: string;
  reasons: string;
}): Promise<CardCandidate[]> {
  const content = await chatJson(
    params.target,
    `You are TC Lingo's flashcard extractor. From a learner's original attempt, the corrected ${params.targetLanguage} version, and the explanation of what changed, pick 1 to 3 of the most reusable words or short phrases the learner should drill (prioritize things they got wrong or phrased awkwardly, not things that were already correct). For each, return a card. Return only JSON: an array of objects, each with exactly these keys: "front" (the ${params.targetLanguage} word/phrase), "reading" (pronunciation help if useful for ${params.targetLanguage}, else empty string), "meaning" (translation/definition in ${params.nativeLanguage}), "exampleSentence" (a natural short example sentence in ${params.targetLanguage} using it, ideally adapted from the corrected text), "context" (when/how it's used, in ${params.nativeLanguage}), "cloze" (the example sentence with the front word/phrase replaced by "___"). Return an empty array if nothing is worth drilling.`,
    { original: params.original, corrected: params.corrected, reasons: params.reasons },
  );
  return parseCardCandidates(content);
}
