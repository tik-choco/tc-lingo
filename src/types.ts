// Central domain types for TC Lingo. See CLAUDE.md for the design rationale
// (retrieval practice + structured output/feedback + same-topic repetition).

export type MainTab = "practice" | "reading" | "talk" | "review" | "cards" | "history" | "settings";

/** How a card entered the deck: typed in by hand, auto-extracted from an AI
 * correction during a practice round, imported from the `lingo-card-inbox`
 * sharedBus topic (tc-translate's translation/explain history — see
 * lib/cardInbox.ts), or saved verbatim from a practice correction's
 * corrected sentence (see lib/sentenceCards.ts). */
export type CardSource = "manual" | "mistake" | "translate" | "sentence";

/** Extended SRS card: word/phrase plus enough context to review it as more
 * than a bare flashcard (reading, an example sentence, when it's used, and
 * an optional cloze prompt for the review screen's recall step). */
export interface Card {
  id: string;
  front: string;
  reading: string;
  meaning: string;
  exampleSentence: string;
  context: string;
  cloze: string;
  source: CardSource;
  sourceTopicId: string | null;
  /** Which of the learner's target languages this card is in. "" for cards
   * saved before multi-language support existed — treated as visible under
   * every language filter rather than orphaned. */
  language: string;
  createdAt: string;
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  reps: number;
  lapses: number;
}

export type ReviewGrade = "again" | "hard" | "good" | "easy";

/** A practice theme, either user-written or AI-suggested. */
export interface Topic {
  id: string;
  title: string;
  prompt: string;
  custom: boolean;
  /** Which of the learner's target languages this topic is written in. ""
   * for topics saved before multi-language support existed. */
  language: string;
  createdAt: string;
}

/** round 1 = 初回, 2 = 同日の改善版, 3 = 翌日以降の再挑戦。 */
export type AttemptRound = 1 | 2 | 3;

/** One output+feedback round against a topic. */
export interface PracticeAttempt {
  id: string;
  topicId: string;
  round: AttemptRound;
  createdAt: string;
  original: string;
  corrected: string;
  /** Always-visible reading aid for `corrected` (e.g. pinyin — see
   * lib/languages.ts readingAid); "" for languages without one and attempts
   * saved before reading aids existed. */
  correctedReading: string;
  reasons: string;
  retryPrompt: string;
  /** Reading aid for `retryPrompt`; "" when none. */
  retryPromptReading: string;
  retryAnswer: string;
  /** AI-corrected version of retryAnswer, from a learner-triggered "check my
   * answer" pass over the retry (see PracticeView). "" until checked. */
  retryCorrected: string;
  /** Reading aid for `retryCorrected`; "" when unchecked / no aid. */
  retryCorrectedReading: string;
  /** Explanation for retryCorrected, in the learner's native language. */
  retryReasons: string;
}

/** One AI-generated comprehensible-input passage (読む tab). Sentences stay
 * aligned with their native-language translations so the view can offer a
 * per-sentence translation reveal and per-sentence TTS. See lib/reading.ts
 * for CRUD + generation. */
export interface ReadingPassage {
  id: string;
  /** Target language the passage is written in. */
  language: string;
  title: string;
  /** `reading` is an always-visible reading aid for the sentence (e.g. pinyin
   * — see lib/languages.ts readingAid); "" for languages without one and for
   * passages saved before reading aids existed. */
  sentences: { text: string; translation: string; reading: string }[];
  /** Due-review card fronts the generator was asked to weave in (spaced
   * re-use, same rationale as requestTopicSuggestion's reviewWords). */
  reviewWords: string[];
  /** One short comprehension question in the target language, plus its
   * expected answer, for a quick retrieval check after reading. */
  question: string;
  questionAnswer: string;
  createdAt: string;
}

export type ConversationRole = "assistant" | "learner";

/** One turn of the 会話 tab's dialogue. Correction fields are only ever
 * non-empty on learner turns ("" = nothing to correct / not a learner turn). */
export interface ConversationTurn {
  id: string;
  role: ConversationRole;
  text: string;
  /** Always-visible reading aid for `text` (e.g. pinyin — see
   * lib/languages.ts readingAid); "" for languages without one, learner
   * turns, and turns saved before reading aids existed. */
  reading: string;
  /** Corrected version of a learner turn; "" when it was already natural. */
  corrected: string;
  /** Reading aid for `corrected`; "" when no correction / no aid. */
  correctedReading: string;
  /** Why, in the learner's native language. "" when no correction. */
  reasons: string;
}

/** One 会話 session: a scenario plus its turns. See lib/conversation.ts. */
export interface ConversationSession {
  id: string;
  /** Target language the dialogue is held in. */
  language: string;
  /** Short scenario label in the learner's native language. */
  title: string;
  /** The scenario instruction the AI partner follows. */
  scenario: string;
  turns: ConversationTurn[];
  createdAt: string;
  /** Set when the learner ends the session; "" while still active. */
  endedAt: string;
}

export type CefrBand = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

/** Per-language proficiency estimate driving automatic level adjustment
 * (reading passages, conversation partner, topic suggestions, practice
 * feedback/retry, mistake-card extraction, grammar explanations). Fed by
 * correction-density samples from practice/talk output — see lib/level.ts
 * for the scoring model and the prompt-fragment helper. */
export interface LanguageLevelRecord {
  language: string;
  /** 0..1 EMA of how correction-free recent output was (1 = flawless). */
  score: number;
  /** How many output samples fed the score; a band is only derived once
   * there are enough (see lib/level.ts MIN_SAMPLES). */
  samples: number;
  /** Manual pin from the settings screen; "" = automatic estimation. */
  override: CefrBand | "";
  updatedAt: string;
}

/** Which transport the app's LLM calls should use: a direct API preset from
 * the shared llm config (see lib/llmConfig.ts), or the P2P AI Network room
 * (mistllm-wire v1) configured at `llmConfig.network.roomId`. See
 * lib/llmConnection.ts for how this is resolved into an actual connection. */
export type LlmConnectionMode = "api" | "network";

/** How hard the model should "think" on a request — sent to the upstream API
 * as `reasoning_effort` on every LLM call, including the "none" case (it is a
 * value the caller chose, not the absence of one). See
 * lib/llmConnection.ts's `connectionForTask`, which resolves the effective
 * value per task (`LingoSettings.taskReasoningEfforts`, falling back to
 * `defaultReasoningEffort`). Same union as tc-translate's `ReasoningEffort` —
 * see tc-docs/drafts/llm-settings-common-v1.md §2.3. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

/** Which engine "read this aloud" (hooks/useSpeech.ts) should use: the
 * browser's built-in Web Speech API, an OpenAI-compatible `/audio/speech`
 * endpoint (the shared llm config's `tts` entry, see lib/llmConfig.ts's
 * resolveVoice), or the same endpoint reached over the AI Network room
 * (lib/network.ts's requestNetworkTts). All three degrade to "browser" when
 * unconfigured/unreachable — see useSpeech for the fallback chain. Unlike the
 * other fields on this type, this is never stored in `LingoSettings` — it is
 * always DERIVED from the shared llm config by `lib/voice.ts`'s
 * `deriveVoiceEngine` (see tc-docs/drafts/llm-settings-common-v1.md §4.1). */
export type TtsEngine = "browser" | "api" | "network";

/** Which app task an LLM call is for, so a per-task preset override
 * (`LingoSettings.taskPresetIds`) can pick a different shared preset (and
 * therefore a different model/provider) than the default for that one task —
 * e.g. a cheaper/faster model for "cards" extraction, a stronger one for
 * "practice" correction. "practice" is requestFeedback/requestRetryFeedback
 * (練習の添削), "topic" is requestTopicSuggestion/planTopicFanOut (トピック提案),
 * "cards" is requestMistakeCards/requestTranslationCards/
 * requestSentenceCardInfo/autoExtract (カード抽出), "review" is
 * judgeReviewAnswer (復習の解答判定), "reading" is lib/reading.ts's passage
 * generation (読解教材の生成), "conversation" is lib/conversation.ts (会話),
 * "grammar" is lib/grammar.ts (文法解説), and "ui-translation" is
 * lib/uiTranslation.ts's runtime UI-string translation (UI文言のLLM翻訳). See
 * lib/llmConnection.ts's `connectionForTask` for how the preset id (and the
 * paired `taskReasoningEfforts` entry) resolve into an actual connection —
 * a task preset that itself resolves to a `mist-network://` pseudo-provider
 * routes over the AI Network room even when `connectionMode` is "api" (see
 * tc-docs/drafts/llm-settings-common-v1.md §2.3/§6). */
export type LlmTask =
  | "practice"
  | "topic"
  | "cards"
  | "review"
  | "reading"
  | "conversation"
  | "grammar"
  | "ui-translation";

/** Supports studying more than one language at once: `targetLanguages` is
 * the full set the learner is juggling, `activeLanguage` (always a member of
 * `targetLanguages`) is which one Practice/Review/Cards/History currently
 * filter to. See lib/settings.ts for the CRUD + migration from the old
 * single-`targetLanguage` shape. */
export interface LingoSettings {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  connectionMode: LlmConnectionMode;
  /** Whether corrections (practice feedback, talk replies) automatically
   * extract mistake cards in the background (lib/autoExtract.ts) instead of
   * waiting for the learner to press the manual extract button. */
  autoExtractCards: boolean;
  /** Whether target-language text shows its always-visible reading aid line
   * (e.g. pinyin for Chinese — see lib/languages.ts readingAid). Display-only:
   * readings are still generated and stored while this is off. */
  showReadingAids: boolean;
  /** Whether this app participates in the AI Network room as a *provider*
   * (serving llm_request/tts_request traffic from other peers), independent
   * of `connectionMode` (a device can consume via direct API while also
   * serving others, or vice versa). See hooks/useNetworkProvider.ts. */
  networkProviderEnabled: boolean;
  /** Ids (into the shared llm config's `presets`) of the presets this app
   * shares when acting as an AI Network provider. Presets backed by a
   * `mist-network://` pseudo-provider are excluded even if listed here (no
   * re-sharing — see hooks/useNetworkProvider.ts's `resolveSharedTargets`). */
  networkProviderPresetIds: string[];
  /** Per-task preset override: which shared llm config preset
   * (lib/llmConfig.ts) an LLM task should use instead of the shared
   * `defaultPresetId`. Missing key or "" for a task means "follow the
   * default preset" (see lib/llmConfig.ts's `resolvePreset` fallback). A
   * task preset that itself resolves to a `mist-network://` pseudo-provider
   * routes that task over the AI Network room even when `connectionMode` is
   * "api" — see lib/llmConnection.ts's `connectionForTask`. */
  taskPresetIds: Partial<Record<LlmTask, string>>;
  /** Per-task `reasoning_effort` override, sent on every request for that
   * task (including "none" — it is always sent, never omitted). Missing key
   * for a task means "follow `defaultReasoningEffort`". Only meaningful for
   * "api"-resolved connections — an AI Network room's provider picks its own
   * reasoning effort regardless. See lib/llmConnection.ts's
   * `connectionForTask`. */
  taskReasoningEfforts: Partial<Record<LlmTask, ReasoningEffort>>;
  /** `reasoning_effort` used for any task without its own
   * `taskReasoningEfforts` entry. */
  defaultReasoningEffort: ReasoningEffort;
}
