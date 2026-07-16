// Central domain types for TC Lingo. See CLAUDE.md for the design rationale
// (retrieval practice + structured output/feedback + same-topic repetition).

export type MainTab = "practice" | "review" | "cards" | "history" | "settings";

/** How a card entered the deck: typed in by hand, or auto-extracted from an
 * AI correction during a practice round. */
export type CardSource = "manual" | "mistake";

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

/** Which transport the app's LLM calls should use: a direct API preset from
 * the shared llm config (see lib/llmConfig.ts), or the P2P AI Network room
 * (mistllm-wire v1) configured at `llmConfig.network.roomId`. See
 * lib/llmConnection.ts for how this is resolved into an actual connection. */
export type LlmConnectionMode = "api" | "network";

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
}
