// LLM calls: structured output+correction feedback, topic suggestion, and
// mistake→flashcard extraction. All three are one-shot JSON requests
// (stream: false semantics achieved by ignoring onDelta) against whichever
// connection the user has configured — either a direct API preset (see
// lib/llmConfig.ts and lib/settings.ts) or the P2P AI Network room
// (mistllm-wire v1, see lib/network.ts / lib/llmConnection.ts). Callers pass
// a resolved `LlmConnection`; this module just branches on its `kind`.
import { MistaiError, streamChatCompletion } from "@tik-choco/mistai";
import type { ChatMessage } from "@tik-choco/mistai";
import { t } from "../i18n";
import type { ResolvedLlmTargetV1 } from "./llmConfig";
import type { LlmConnection } from "./llmConnection";
import { requestNetworkChat } from "./network";
import {
  parseAnswerVerdict,
  parseCardCandidates,
  parseCardConsistencyResult,
  parseCardMergeGroups,
  parseClozeVariation,
  parseFeedback,
  parseRetryFeedback,
  parseSentenceCards,
  parseTopicFanOutPlan,
  parseTopicSuggestion,
} from "./parse";
import type {
  AnswerVerdict,
  CardCandidate,
  CardConsistencyResult,
  CardMergeGroup,
  FeedbackResult,
  RetryFeedbackResult,
  SentenceCardCandidate,
  TopicFanOutPlan,
  TopicSuggestion,
} from "./parse";
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
      ? // `connection.model` is only ever set by lib/llmConnection.ts's
        // connectionForTask, for a task whose resolved preset itself points
        // at a mist-network:// pseudo-provider (an AI-Network-imported
        // model) - in that case the room's provider needs the advertised
        // name to route to the right upstream preset. Otherwise (the plain
        // "use the AI Network" global toggle) it's omitted, so the room's
        // provider falls back to its own configured default model instead of
        // being asked for a model name it may not offer.
        await requestNetworkChat(connection.roomId, messages, connection.model)
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

/**
 * Streaming chat round-trip against one specific resolved shared-config
 * preset (see lib/llmConfig.ts's `resolvePreset`), used by
 * hooks/useNetworkProvider.ts's `callLlm` to forward an incoming AI Network
 * llm_request to whichever shared preset the requested (advertised) name
 * matched — as opposed to `chatJson`'s `connectionForTask`-resolved
 * connection, which is this app's own outgoing calls. `reasoning_effort` is
 * always sent (falls back to "none", never omitted — see types.ts's
 * `ReasoningEffort`), same as `chatConfig` above; unlike an outgoing call's
 * connection, a forwarded request has no per-task override to apply, so the
 * preset's own `reasoningEffort` (if any) is used as-is.
 */
export async function requestResolvedChatCompletionStreaming(
  target: ResolvedLlmTargetV1,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
): Promise<string> {
  const full = await streamChatCompletion(
    {
      baseUrl: target.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: target.apiKey,
      model: target.model.trim(),
      temperature: target.temperature,
      reasoningEffort: target.reasoningEffort ?? "none",
    },
    messages,
    onDelta,
  );
  if (!full.trim()) throw new MistaiError("UPSTREAM_BAD_RESPONSE", "The provider returned an empty response.");
  return full;
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
    `You are TC Lingo's writing/speaking coach. The learner is producing output in ${params.targetLanguage}; explanations must be written in ${params.nativeLanguage}. Given a topic prompt and the learner's attempt, correct their text naturally (fix grammar, word choice, and unnatural phrasing while preserving their intended meaning), explain the key reasons for each correction in ${params.nativeLanguage} (concise, bullet-like sentences), and propose one short follow-up question or variation in ${params.targetLanguage} that lets the learner immediately retry using the corrected pattern. Return only JSON with exactly these keys: "corrected" (the corrected ${params.targetLanguage} text), "correctedTranslation" (a ${params.nativeLanguage} translation of "corrected", for a learner who can't read it unaided), "reasons" (explanation in ${params.nativeLanguage}), "retryPrompt" (a short follow-up prompt in ${params.targetLanguage}), "retryPromptTranslation" (a ${params.nativeLanguage} translation of "retryPrompt", for a learner who can't read it unaided)${readingKeys}. Do not restate the original text.${levelHint}`,
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
    `You are TC Lingo's writing/speaking coach. The learner is producing output in ${params.targetLanguage}; explanations must be written in ${params.nativeLanguage}. They already got feedback on an initial attempt at the topic prompt, and are now answering a short follow-up question (retryPrompt) meant to let them retry using the corrected pattern. Given the topic prompt, the follow-up question, and the learner's answer to it, correct their answer naturally (fix grammar, word choice, and unnatural phrasing while preserving their intended meaning) and explain the key reasons for each correction in ${params.nativeLanguage} (concise, bullet-like sentences). Return only JSON with exactly these keys: "corrected" (the corrected ${params.targetLanguage} text), "correctedTranslation" (a ${params.nativeLanguage} translation of "corrected", for a learner who can't read it unaided), "reasons" (explanation in ${params.nativeLanguage})${readingKeys}. Do not restate the original answer.${levelInstruction(params.targetLanguage)}`,
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
    `You are TC Lingo's topic generator. Suggest one short, concrete daily speaking/writing topic for a learner of ${params.targetLanguage} (whose native language is ${params.nativeLanguage}), answerable in about 60-90 seconds or a short paragraph. Prefer everyday, personal, or opinion topics over abstract ones. Avoid repeating any topic in recentTitles, and deliberately vary the theme/domain from the most recent titles (if they lean on one area — say daily routines — switch to opinions, memories, plans, culture, or light hypotheticals) so consecutive topics feel fresh rather than same-y.${themeHint}${requestHint}${reviewHint}${levelHint} Return only JSON with exactly these keys: "title" (a short label in ${params.nativeLanguage}), "prompt" (the actual instruction/question, written in ${params.targetLanguage}), "promptTranslation" (a ${params.nativeLanguage} translation of "prompt", for a learner who can't read it unaided).`,
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
    `You are TC Lingo's flashcard extractor. From a learner's original attempt, the corrected ${params.targetLanguage} version, and the explanation of what changed, pick 1 to 3 of the most reusable words or short phrases the learner should drill (prioritize things they got wrong or phrased awkwardly, not things that were already correct). For each, return a card. Return only JSON: an array of objects, each with exactly these keys: "front" (the ${params.targetLanguage} word/phrase), "reading" (${reading.llmInstruction}), "meaning" (translation/definition in ${params.nativeLanguage}), "exampleSentence" (a natural short example sentence in ${params.targetLanguage} using it, ideally adapted from the corrected text), "context" (when/how it's used, in ${params.nativeLanguage}), "cloze" (exampleSentence with front replaced by "___" — front must appear verbatim, unmodified, as a contiguous span of exampleSentence, so substituting front back into cloze's blank reproduces exampleSentence exactly; if front doesn't literally occur that way in a natural exampleSentence, shorten front to the word/phrase that does, rather than forcing a mismatched cloze). Return an empty array if nothing is worth drilling.${levelInstruction(params.targetLanguage)}`,
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
    `You are TC Lingo's flashcard extractor. From a source sentence and its ${params.targetLanguage} translation, pick 1 to 3 of the most reusable words or short phrases from the ${params.targetLanguage} translation that a learner should drill (prioritize vocabulary and set phrases over grammar particles or proper nouns). For each, return a card. Return only JSON: an array of objects, each with exactly these keys: "front" (the ${params.targetLanguage} word/phrase), "reading" (${reading.llmInstruction}), "meaning" (translation/definition in ${params.nativeLanguage}), "exampleSentence" (a natural short example sentence in ${params.targetLanguage} using it, ideally the translation itself or adapted from it), "context" (when/how it's used, in ${params.nativeLanguage}), "cloze" (exampleSentence with front replaced by "___" — front must appear verbatim, unmodified, as a contiguous span of exampleSentence, so substituting front back into cloze's blank reproduces exampleSentence exactly; if front doesn't literally occur that way in a natural exampleSentence, shorten front to the word/phrase that does, rather than forcing a mismatched cloze). Return an empty array if nothing is worth drilling.${levelInstruction(params.targetLanguage)}`,
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

/** CardsView's "類似カードを整理" cleanup tool: given the learner's current
 * deck (one language's worth, as currently filtered/shown by the caller),
 * finds groups of cards that aren't worth reviewing as separate cards —
 * true duplicates, near-synonyms covering the same meaning, or the same
 * core word/phrase differing only in grammatical form (tense, singular/
 * plural, conjugation, politeness level, minor spelling variant) — and
 * proposes one consolidated replacement card per group. The caller (never
 * this function) applies any of the proposed merges, and only after the
 * learner reviews and accepts them (lib/cards.ts mergeCards). */
export async function requestCardMerges(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  cards: Array<{ id: string; front: string; reading: string; meaning: string; exampleSentence: string; context: string; cloze: string }>;
}): Promise<CardMergeGroup[]> {
  if (params.cards.length < 2) return [];
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's flashcard deck curator. The learner has too many ${params.targetLanguage} review cards (native language: ${params.nativeLanguage}) and wants help consolidating ones that don't need to stay separate. Given the full list of cards (each with an "id"), find groups of 2 or more cards that are redundant to review individually: true duplicates, near-synonyms that cover the same meaning, or the same core word/phrase differing only in grammatical form (tense, singular/plural, verb conjugation, politeness/formality level, or a minor spelling variant). Do NOT group cards that test genuinely different vocabulary, meanings, or usages, even if they look superficially similar — when in doubt, leave them ungrouped. For each group, propose one consolidated replacement card that preserves the learning value of the originals (e.g. mention notable alternate forms in "context" or weave them into "exampleSentence" when useful, instead of silently dropping them). Return only JSON: an array of objects, each with exactly these keys: "cardIds" (array of the original card ids being merged, from the input), "merged" (an object with "front", "reading", "meaning", "exampleSentence", "context", "cloze" — same shape as the input cards; "cloze" must be "exampleSentence" with "front" replaced by "___", with "front" appearing verbatim, unmodified, as a contiguous span of "exampleSentence" so substituting "front" back into "cloze"'s blank reproduces "exampleSentence" exactly), "reason" (one short sentence in ${params.nativeLanguage} explaining why these were grouped). Return an empty array if nothing should be merged.`,
    { cards: params.cards },
  );
  return parseCardMergeGroups(
    content,
    new Set(params.cards.map((c) => c.id)),
  );
}

/** lib/reviewConsistencyCheck.ts's background QA pass: cards occasionally
 * come out of extraction/merging with a `front` that doesn't actually fit
 * `cloze`'s blank (e.g. front carries an extra word not present at that
 * position in exampleSentence — see requestMistakeCards/requestTranslationCards/
 * requestCardMerges's cloze-consistency instruction, which this exists to
 * catch when a model didn't follow it). Checked, not assumed: whether
 * `front` fits `cloze` can't be verified with plain string matching for
 * languages without whitespace word boundaries (Japanese, Chinese, ...), so
 * this asks the model directly instead. Best-effort — callers treat a
 * thrown/malformed response as "assume consistent, don't touch the card". */
export async function requestCardConsistencyCheck(params: {
  connection: LlmConnection;
  targetLanguage: string;
  card: { front: string; exampleSentence: string; cloze: string };
}): Promise<CardConsistencyResult> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's flashcard QA checker. A flashcard has a "front" (the word/phrase to drill), an "exampleSentence", and a "cloze" version of exampleSentence with front's occurrence replaced by one or more "___" blanks. Check whether substituting front back into cloze's blank(s), in order, exactly reproduces exampleSentence (ignoring only whitespace differences). If it does, return {"consistent": true}. If it doesn't (front is missing/extra words, doesn't match the wording actually used in exampleSentence, or the blank count doesn't correspond to front), return {"consistent": false, "front": <a corrected front that IS a verbatim span of exampleSentence>, "cloze": <exampleSentence with that corrected front replaced by "___", so substituting it back reproduces exampleSentence exactly>}. Keep the corrected front as close as possible to the original front's core word/phrase — only trim or adjust it enough to fit exampleSentence, don't invent a different vocabulary item. This is ${params.targetLanguage} text. Return only JSON with exactly the keys described above.`,
    { front: params.card.front, exampleSentence: params.card.exampleSentence, cloze: params.card.cloze },
  );
  return parseCardConsistencyResult(content);
}

/** lib/reviewClozeVariation.ts's background variety generator: a card
 * reviewed for the Nth time keeps showing the exact same cloze sentence,
 * which risks the learner memorizing that one sentence instead of
 * genuinely recalling "front" — this generates a fresh natural sentence
 * using the same word/phrase in different wording/context each time, kept
 * ephemeral (never persisted; the card's own stored cloze/exampleSentence
 * stay canonical). Same cloze-consistency requirement as the
 * card-generating prompts above. */
export async function requestClozeVariation(params: {
  connection: LlmConnection;
  targetLanguage: string;
  card: { front: string; reading: string; meaning: string; exampleSentence: string };
}): Promise<string> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's flashcard variety generator. The learner has reviewed this card before; showing the exact same example sentence every time risks them memorizing that sentence instead of genuinely recalling the word. Given the card's "front" (the ${params.targetLanguage} word/phrase), "meaning", and its original "exampleSentence", write ONE new, natural ${params.targetLanguage} example sentence that uses front, clearly different in wording and context from the original exampleSentence, then express it as a cloze with front's occurrence replaced by "___". front must appear verbatim, unmodified, as a contiguous span of your new sentence, so substituting it back into the blank reproduces your new sentence exactly. Return only JSON: {"cloze": string}.`,
    { front: params.card.front, reading: params.card.reading, meaning: params.card.meaning, originalExampleSentence: params.card.exampleSentence },
  );
  return parseClozeVariation(content);
}

/** The review tab's second-opinion judge: strict string matching (lib/srs.ts
 * judgeAnswer) can't tell a synonym, a right-word-wrong-form slip, or an
 * alternative spelling from a genuinely wrong answer, so when a non-blank
 * typed answer fails the strict check and an LLM connection exists, this
 * gives a three-way verdict on the typed answer for THIS card. Best-effort —
 * callers fall back to the strict judgement on any error rather than
 * surfacing one. */
export async function judgeReviewAnswer(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  card: { front: string; reading: string; meaning: string; context: string; cloze: string };
  typedAnswer: string;
}): Promise<AnswerVerdict> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's review-answer judge. A learner of ${params.targetLanguage} (native language: ${params.nativeLanguage}) was reviewing a flashcard: shown the card's meaning (and its cloze sentence when present), they had to recall and type the ${params.targetLanguage} expression. The expected answer is the card's "front"; their typed answer did not match it exactly. Classify the typed answer against THIS card's expected answer as one of three verdicts: "correct" — a synonym, alternative spelling/script, or equivalent phrasing that a teacher would accept as naturally expressing the card's meaning in the card's context (including the cloze sentence, if there is one); "near" — the learner clearly recalled the right word or expression, but produced the wrong grammatical form of it (wrong tense, singular/plural, verb conjugation, politeness/formality level, or a minor spelling/typo slip) — they know the vocabulary, they just didn't produce the exact form the card expects; "wrong" — the answer means something different, is unrelated, or is not a recognizable attempt at the expected word/expression. Be fair but not lenient — close in spelling but different in meaning is "wrong", not "near". Return only JSON with exactly these keys: "verdict" ("correct", "near", or "wrong"), "note" (one short sentence in ${params.nativeLanguage}, always phrased around what the LEARNER typed, never describing the expected answer itself as missing or wrong: if correct, confirm the learner's expression also works and mention the card's expected one; if near, tell the learner concretely what to change in what they typed to reach the expected form — e.g. "change it to past tense" or "add り at the end" — not a description of the expected answer in isolation; if wrong, briefly say how their answer differs in meaning from the expected one).`,
    { card: params.card, typedAnswer: params.typedAnswer },
  );
  return parseAnswerVerdict(content);
}
