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
  reasons: string;
  retryPrompt: string;
  retryAnswer: string;
  /** AI-corrected version of retryAnswer, from a learner-triggered "check my
   * answer" pass over the retry (see PracticeView). "" until checked. */
  retryCorrected: string;
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
  sentences: { text: string; translation: string }[];
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
  /** Corrected version of a learner turn; "" when it was already natural. */
  corrected: string;
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

/** Which engine "read this aloud" (hooks/useSpeech.ts) should use: the
 * browser's built-in Web Speech API, an OpenAI-compatible `/audio/speech`
 * endpoint (the shared llm config's `tts` entry, see lib/llmConfig.ts's
 * resolveVoice), or the same endpoint reached over the AI Network room
 * (lib/network.ts's requestNetworkTts). All three degrade to "browser" when
 * unconfigured/unreachable — see useSpeech for the fallback chain. */
export type TtsEngine = "browser" | "api" | "network";

/** Supports studying more than one language at once: `targetLanguages` is
 * the full set the learner is juggling, `activeLanguage` (always a member of
 * `targetLanguages`) is which one Practice/Review/Cards/History currently
 * filter to. See lib/settings.ts for the CRUD + migration from the old
 * single-`targetLanguage` shape. */
export interface LingoSettings {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: TtsEngine;
  /** Whether corrections (practice feedback, talk replies) automatically
   * extract mistake cards in the background (lib/autoExtract.ts) instead of
   * waiting for the learner to press the manual extract button. */
  autoExtractCards: boolean;
}
