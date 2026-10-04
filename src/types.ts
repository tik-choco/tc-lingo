import type { LlmLocalSettings } from "@tik-choco/mistai/preact";
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
  /** Native-language translation of `exampleSentence`, revealed on demand
   * (same idea as ReadingPassage's per-sentence translation); "" for cards
   * saved before this feature existed, or when generation didn't provide
   * one (e.g. manually-entered cards). */
  exampleSentenceTranslation: string;
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
  /** ISO timestamp, bumped on every mutation to this card; exists for the
   * device-to-device sync feature's LWW merge — see lib/sync/types.ts. */
  updatedAt: string;
}

export type ReviewGrade = "again" | "hard" | "good" | "easy";

/** A practice theme, either user-written or AI-suggested. */
export interface Topic {
  id: string;
  title: string;
  prompt: string;
  /** Native-language translation of `prompt`, revealed on demand (same idea
   * as ReadingPassage's per-sentence translation); "" for topics saved
   * before this feature existed. */
  promptTranslation: string;
  custom: boolean;
  /** Which of the learner's target languages this topic is written in. ""
   * for topics saved before multi-language support existed. */
  language: string;
  createdAt: string;
  /** ISO timestamp, bumped on every mutation to this topic; exists for the
   * device-to-device sync feature's LWW merge — see lib/sync/types.ts. */
  updatedAt: string;
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
  /** Native-language translation of `corrected`, revealed on demand (same
   * idea as ReadingPassage's per-sentence translation); "" when none, or
   * attempts saved before this feature existed. */
  correctedTranslation: string;
  reasons: string;
  retryPrompt: string;
  /** Reading aid for `retryPrompt`; "" when none. */
  retryPromptReading: string;
  /** Native-language translation of `retryPrompt`, revealed on demand (same
   * idea as ReadingPassage's per-sentence translation); "" when none, or
   * attempts saved before this feature existed. */
  retryPromptTranslation: string;
  retryAnswer: string;
  /** AI-corrected version of retryAnswer, from a learner-triggered "check my
   * answer" pass over the retry (see PracticeView). "" until checked. */
  retryCorrected: string;
  /** Reading aid for `retryCorrected`; "" when unchecked / no aid. */
  retryCorrectedReading: string;
  /** Native-language translation of `retryCorrected`; "" when unchecked /
   * none, or attempts saved before this feature existed. */
  retryCorrectedTranslation: string;
  /** Explanation for retryCorrected, in the learner's native language. */
  retryReasons: string;
  /** ISO timestamp, bumped on every mutation to this attempt; exists for the
   * device-to-device sync feature's LWW merge — see lib/sync/types.ts. */
  updatedAt: string;
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
  /** ISO timestamp, bumped on every mutation to this passage; exists for the
   * device-to-device sync feature's LWW merge — see lib/sync/types.ts. */
  updatedAt: string;
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
  /** Native-language translation of `text`, revealed on demand (same idea as
   * ReadingPassage's per-sentence translation); "" for learner turns and
   * turns saved before this feature existed. */
  translation: string;
  /** Corrected version of a learner turn; "" when it was already natural. */
  corrected: string;
  /** Reading aid for `corrected`; "" when no correction / no aid. */
  correctedReading: string;
  /** Native-language translation of `corrected`, revealed on demand (same
   * idea as `translation`); "" when no correction, or turns saved before
   * this feature existed. */
  correctedTranslation: string;
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
  /** ISO timestamp, bumped on every mutation to this session; exists for the
   * device-to-device sync feature's LWW merge — see lib/sync/types.ts. */
  updatedAt: string;
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

export type ReasoningEffort = import("@tik-choco/mistai/preact").ReasoningEffort;
export type TtsEngine = "browser" | "api" | "network";
export type LlmTask = "practice" | "topic" | "cards" | "review" | "reading" | "conversation" | "grammar" | "ui-translation" | "card-organize";

export interface LingoSettings extends LlmLocalSettings {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  autoExtractCards: boolean;
  showReadingAids: boolean;
  autoOrganizeCards: boolean;
  lastCardAutoOrganizeAt: string;
  // Each model ref owns its language voices, so changing models cannot reuse stale voice IDs.
  ttsVoicesByRef: Record<string, Record<string, string>>;
}
