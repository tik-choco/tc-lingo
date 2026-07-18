// LLM calls: structured output+correction feedback, topic suggestion, and
// mistake→flashcard extraction. All three are one-shot JSON requests
// (stream: false semantics achieved by ignoring onDelta) against whichever
// connection the user has configured — either a direct API preset (see
// lib/llmConfig.ts and lib/settings.ts) or the P2P AI Network room
// (mistllm-wire v1, see lib/network.ts / lib/llmConnection.ts). Callers pass
// a resolved `LlmConnection`; this module just branches on its `kind`.
import { streamChatCompletion } from "@tik-choco/mistai";
import type { ChatMessage } from "@tik-choco/mistai";
import { t } from "../i18n";
import type { ResolvedLlmTargetV1 } from "./llmConfig";
import type { LlmConnection } from "./llmConnection";
import { requestNetworkChat } from "./network";
import { parseAnswerVerdict, parseCardCandidates, parseFeedback, parseRetryFeedback, parseSentenceCards, parseTopicFanOutPlan, parseTopicSuggestion } from "./parse";
import type { AnswerVerdict, CardCandidate, FeedbackResult, RetryFeedbackResult, SentenceCardCandidate, TopicFanOutPlan, TopicSuggestion } from "./parse";
import { readingAid, readingSpec } from "./languages";
import { levelInstruction } from "./level";

function chatConfig(target: ResolvedLlmTargetV1) {
  return {
    baseUrl: target.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: target.apiKey,
    model: target.model,
    temperature: target.temperature,
    reasoningEffort: target.reasoningEffort,
  };
}

/** Shared one-shot JSON round-trip over the configured transport. Exported
 * for the sibling LLM-call modules (lib/reading.ts, lib/conversation.ts,
 * lib/grammar.ts) so they don't each reimplement the transport branch. */
export async function chatJson(connection: LlmConnection, systemPrompt: string, userPayload: unknown): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(userPayload) },
  ];
  const content =
    connection.kind === "network"
      ? // Don't force this client's own (API-mode) model onto the request:
        // the room's provider falls back to its own configured model
        // whenever no model is specified, so omitting it here makes the
        // network connection automatically use whatever model the connected
        // peer has set up, instead of demanding a model name it may not
        // offer. Same rationale as tc-translate's lib/llm.ts.
        await requestNetworkChat(connection.roomId, messages, undefined)
      : await streamChatCompletion(chatConfig(connection.target), messages);
  if (!content.trim()) throw new Error(t("error-empty-response"));
  return content;
}

/** Minimal round-trip used by the onboarding wizard's "接続テスト" button —
 * confirms the endpoint/key/model actually work before the learner leaves
 * the setup step, independent of any of this app's JSON-shaped prompts. */
export async function testConnection(target: { baseUrl: string; apiKey: string; model: string }): Promise<void> {
  const content = await streamChatCompletion(
    { baseUrl: target.baseUrl.trim().replace(/\/+$/, ""), apiKey: target.apiKey, model: target.model },
    [{ role: "user", content: 'Connection test. Reply with only "OK".' }],
  );
  if (!content.trim()) throw new Error(t("error-empty-test-response"));
}

/** Same round-trip as `testConnection`, but over the AI Network room instead
 * of a direct API preset — used by the Settings/Onboarding room-id field's
 * own "接続テスト" button. */
export async function testNetworkConnection(roomId: string): Promise<void> {
  const content = await requestNetworkChat(roomId, [{ role: "user", content: 'Connection test. Reply with only "OK".' }], undefined);
  if (!content.trim()) throw new Error(t("error-empty-test-response"));
}

export async function requestFeedback(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  topicPrompt: string;
  userText: string;
}): Promise<FeedbackResult> {
  // Calibration is aimed at the retryPrompt/reasons rather than the
  // corrected text itself — a correction must stay fully natural regardless
  // of the learner's level, only the follow-up question and how deep the
  // explanation goes should be pitched to it.
  const level = levelInstruction(params.targetLanguage);
  const levelHint = level
    ? `${level} Apply this calibration especially to the "retryPrompt" follow-up question you write, and pitch the depth of your "reasons" explanations to the same level; the corrected text itself must still be fully natural ${params.targetLanguage}.`
    : "";
  // Always-visible reading aid (e.g. pinyin for Chinese — see
  // lib/languages.ts readingAid): only ask for the extra reading keys when
  // the target language actually has one, so the prompt/response stay
  // unchanged for every other language.
  const aid = readingAid(params.targetLanguage);
  const readingKeys = aid
    ? `, "correctedReading" (${aid.llmInstruction}, for the "corrected" text), "retryPromptReading" (${aid.llmInstruction}, for the "retryPrompt" text)`
    : "";
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's writing/speaking coach. The learner is producing output in ${params.targetLanguage}; explanations must be written in ${params.nativeLanguage}. Given a topic prompt and the learner's attempt, correct their text naturally (fix grammar, word choice, and unnatural phrasing while preserving their intended meaning), explain the key reasons for each correction in ${params.nativeLanguage} (concise, bullet-like sentences), and propose one short follow-up question or variation in ${params.targetLanguage} that lets the learner immediately retry using the corrected pattern. Return only JSON with exactly these keys: "corrected" (the corrected ${params.targetLanguage} text), "reasons" (explanation in ${params.nativeLanguage}), "retryPrompt" (a short follow-up prompt in ${params.targetLanguage})${readingKeys}. Do not restate the original text.${levelHint}`,
    { topicPrompt: params.topicPrompt, learnerText: params.userText },
  );
  return parseFeedback(content);
}

/** "Check my answer" pass over a retry (follow-up) answer: same corrected +
 * reasons shape as requestFeedback but scoped to just the retry exchange, no
 * further retryPrompt. Called on demand from PracticeView, not automatically
 * on every retry keystroke. */
export async function requestRetryFeedback(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  topicPrompt: string;
  retryPrompt: string;
  retryAnswer: string;
}): Promise<RetryFeedbackResult> {
  const aid = readingAid(params.targetLanguage);
  const readingKeys = aid ? `, "correctedReading" (${aid.llmInstruction}, for the "corrected" text)` : "";
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's writing/speaking coach. The learner is producing output in ${params.targetLanguage}; explanations must be written in ${params.nativeLanguage}. They already got feedback on an initial attempt at the topic prompt, and are now answering a short follow-up question (retryPrompt) meant to let them retry using the corrected pattern. Given the topic prompt, the follow-up question, and the learner's answer to it, correct their answer naturally (fix grammar, word choice, and unnatural phrasing while preserving their intended meaning) and explain the key reasons for each correction in ${params.nativeLanguage} (concise, bullet-like sentences). Return only JSON with exactly these keys: "corrected" (the corrected ${params.targetLanguage} text), "reasons" (explanation in ${params.nativeLanguage})${readingKeys}. Do not restate the original answer.${levelInstruction(params.targetLanguage)}`,
    { topicPrompt: params.topicPrompt, retryPrompt: params.retryPrompt, retryAnswer: params.retryAnswer },
  );
  return parseRetryFeedback(content);
}

export async function requestTopicSuggestion(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  recentTitles: string[];
  /** Optional shared theme (from planTopicFanOut) to loosely build on, so
   * topics generated together across several languages feel coordinated
   * rather than random. Omit for a normal single-language suggestion. */
  theme?: string;
  /** Optional due-for-review card fronts (spaced re-use, see CLAUDE.md's
   * core loop diagram) to loosely weave into the generated topic, so
   * practice output naturally re-exercises vocabulary the learner is due to
   * review instead of always drawing on fresh words. Omit or pass [] for a
   * normal suggestion with no review tie-in. */
  reviewWords?: string[];
  /** Optional free-text description of what kind of topic the learner wants
   * right now (e.g. "travel topics", "expressions for business email"),
   * written in any language. When present, generation should honor it,
   * taking priority over the shared theme hint above. Omit for a normal
   * suggestion with no specific request. */
  topicRequest?: string;
  /** Optional level-calibration prompt fragment (lib/level.ts
   * levelInstruction) so suggested topics match the learner's estimated
   * proficiency. Omit/"" when the level is still unknown. */
  levelHint?: string;
}): Promise<TopicSuggestion> {
  const themeHint = params.theme
    ? ` Loosely build today's topic around this shared theme if it fits naturally: "${params.theme}". Don't force it — a good, natural topic beats a forced match.`
    : "";
  const reviewHint =
    params.reviewWords && params.reviewWords.length > 0
      ? ` The learner is due to review these words/phrases (reviewWords): pick 1-2 that would fit naturally into the topic, and include a sentence in prompt nudging the learner to try using them. If none of them fit naturally, ignore reviewWords entirely — a good, natural topic beats a forced vocabulary match.`
      : "";
  const requestHint =
    params.topicRequest && params.topicRequest.trim()
      ? ` The learner described what kind of topic they want (topicRequest): "${params.topicRequest.trim()}". Follow this request when choosing the topic — it takes priority over the shared theme hint above — but the topic must still be short, concrete, and answerable in 60-90 seconds.`
      : "";
  const levelHint = params.levelHint ?? "";
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's topic generator. Suggest one short, concrete daily speaking/writing topic for a learner of ${params.targetLanguage} (whose native language is ${params.nativeLanguage}), answerable in about 60-90 seconds or a short paragraph. Prefer everyday, personal, or opinion topics over abstract ones. Avoid repeating any topic in recentTitles, and deliberately vary the theme/domain from the most recent titles (if they lean on one area — say daily routines — switch to opinions, memories, plans, culture, or light hypotheticals) so consecutive topics feel fresh rather than same-y.${themeHint}${requestHint}${reviewHint}${levelHint} Return only JSON with exactly these keys: "title" (a short label in ${params.nativeLanguage}), "prompt" (the actual instruction/question, written in ${params.targetLanguage}).`,
    { recentTitles: params.recentTitles, reviewWords: params.reviewWords ?? [], topicRequest: params.topicRequest ?? "" },
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
  connection: LlmConnection;
  nativeLanguage: string;
  candidateLanguages: string[];
  recentTitlesByLanguage: Record<string, string[]>;
  /** Optional free-text description of what kind of topic the learner wants
   * right now, in any language (see requestTopicSuggestion's topicRequest).
   * When present, the shared theme should be built around it instead of
   * picked freely. Omit for a normal fan-out with no specific request. */
  topicRequest?: string;
}): Promise<TopicFanOutPlan> {
  if (params.candidateLanguages.length <= 1) {
    return { theme: "", targets: params.candidateLanguages };
  }
  const requestHint =
    params.topicRequest && params.topicRequest.trim()
      ? ` The learner described what kind of topic they want (topicRequest): "${params.topicRequest.trim()}". Build the shared theme around this request instead of picking one freely.`
      : "";
  const content = await chatJson(
    params.connection,
    `You are the orchestrator for TC Lingo's multi-language practice planner. The learner studies several languages at once: ${params.candidateLanguages.join(", ")} (native language: ${params.nativeLanguage}). Given each language's recently used topic titles (recentTitlesByLanguage), pick one short shared theme, written in ${params.nativeLanguage}, that today's topics across all these languages can loosely share, and decide which of the candidate languages should get a freshly generated topic dispatched to a topic-generation worker this round — normally all of them.${requestHint} Return only JSON: {"theme": string, "targets": string[]}. "targets" must be a subset of candidateLanguages, in their original order.`,
    { candidateLanguages: params.candidateLanguages, recentTitlesByLanguage: params.recentTitlesByLanguage, topicRequest: params.topicRequest ?? "" },
  );
  return parseTopicFanOutPlan(content, params.candidateLanguages);
}

export async function requestMistakeCards(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  original: string;
  corrected: string;
  reasons: string;
}): Promise<CardCandidate[]> {
  const reading = readingSpec(params.targetLanguage);
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's flashcard extractor. From a learner's original attempt, the corrected ${params.targetLanguage} version, and the explanation of what changed, pick 1 to 3 of the most reusable words or short phrases the learner should drill (prioritize things they got wrong or phrased awkwardly, not things that were already correct). For each, return a card. Return only JSON: an array of objects, each with exactly these keys: "front" (the ${params.targetLanguage} word/phrase), "reading" (${reading.llmInstruction}), "meaning" (translation/definition in ${params.nativeLanguage}), "exampleSentence" (a natural short example sentence in ${params.targetLanguage} using it, ideally adapted from the corrected text), "context" (when/how it's used, in ${params.nativeLanguage}), "cloze" (the example sentence with the front word/phrase replaced by "___"). Return an empty array if nothing is worth drilling.${levelInstruction(params.targetLanguage)}`,
    { original: params.original, corrected: params.corrected, reasons: params.reasons },
  );
  return parseCardCandidates(content);
}

/** The `lingo-card-inbox` receive flow's optional "AIで語彙を抽出" step (see
 * lib/cardInbox.ts / lib/inboxCandidates.ts for the deterministic mapping
 * this supplements): given a translated sentence pair pulled from a
 * tc-translate history item, pick reusable vocabulary from the ${targetLanguage}
 * side worth drilling. Same one-shot JSON shape as requestMistakeCards, just
 * fed a translation pair instead of a correction. */
export async function requestTranslationCards(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  sourceText: string;
  translationText: string;
}): Promise<CardCandidate[]> {
  const reading = readingSpec(params.targetLanguage);
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's flashcard extractor. From a source sentence and its ${params.targetLanguage} translation, pick 1 to 3 of the most reusable words or short phrases from the ${params.targetLanguage} translation that a learner should drill (prioritize vocabulary and set phrases over grammar particles or proper nouns). For each, return a card. Return only JSON: an array of objects, each with exactly these keys: "front" (the ${params.targetLanguage} word/phrase), "reading" (${reading.llmInstruction}), "meaning" (translation/definition in ${params.nativeLanguage}), "exampleSentence" (a natural short example sentence in ${params.targetLanguage} using it, ideally the translation itself or adapted from it), "context" (when/how it's used, in ${params.nativeLanguage}), "cloze" (the example sentence with the front word/phrase replaced by "___"). Return an empty array if nothing is worth drilling.${levelInstruction(params.targetLanguage)}`,
    { sourceText: params.sourceText, translation: params.translationText },
  );
  return parseCardCandidates(content);
}

/** lib/sentenceCards.ts's "save the corrected sentence as-is" flow: given the
 * changed sentences pulled out of a practice correction, get a reading and a
 * native-language translation for each without letting the model rewrite the
 * sentence itself — the sentence text saved to the card must be exactly what
 * the AI already corrected, not a second, possibly divergent rewrite. */
export async function requestSentenceCardInfo(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  sentences: string[];
}): Promise<SentenceCardCandidate[]> {
  const reading = readingSpec(params.targetLanguage);
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's sentence-card assistant. For each ${params.targetLanguage} sentence given, provide its reading (${reading.llmInstruction}) and a natural translation in ${params.nativeLanguage}. Return the input sentence unchanged as "sentence" — do not rewrite, correct, or paraphrase it. Return only JSON: an array of objects, each with exactly these keys: "sentence" (the original ${params.targetLanguage} sentence, unchanged), "reading", "translation".`,
    { sentences: params.sentences },
  );
  return parseSentenceCards(content);
}

/** The review tab's second-opinion judge: strict string matching (lib/srs.ts
 * judgeAnswer) can't tell a synonym or alternative spelling from a genuinely
 * wrong answer, so when a non-blank typed answer fails the strict check and
 * an LLM connection exists, this asks whether the answer should still count
 * for THIS card. Best-effort — callers fall back to the strict judgement on
 * any error rather than surfacing one. */
export async function judgeReviewAnswer(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  card: { front: string; reading: string; meaning: string; context: string; cloze: string };
  typedAnswer: string;
}): Promise<AnswerVerdict> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's review-answer judge. A learner of ${params.targetLanguage} (native language: ${params.nativeLanguage}) was reviewing a flashcard: shown the card's meaning (and its cloze sentence when present), they had to recall and type the ${params.targetLanguage} expression. The expected answer is the card's "front"; their typed answer did not match it exactly. Decide whether the typed answer should still count as a correct recall for THIS card: accept synonyms, alternative spellings/scripts, and equivalent phrasings that a teacher would accept as naturally expressing the card's meaning in the card's context (including in the cloze sentence, if there is one). Reject answers that mean something different, are the wrong word form for the context, or are ungrammatical. Be fair but not lenient — close in spelling but different in meaning is wrong. Return only JSON with exactly these keys: "acceptable" (boolean), "note" (one short sentence in ${params.nativeLanguage}: if acceptable, confirm the learner's expression also works and mention the card's expected one; if not, briefly say how it differs from the expected answer).`,
    { card: params.card, typedAnswer: params.typedAnswer },
  );
  return parseAnswerVerdict(content);
}
