// Simplified SM-2 spaced-repetition scheduler. Day-granularity intervals
// (no time-of-day scheduling within a day) — good enough for a card deck
// reviewed once or twice a day, and much easier to reason about than a full
// FSRS implementation. Swapping in FSRS later only touches this file.
import type { Card, ReviewGrade } from "../types";

export const MIN_EASE_FACTOR = 1.3;
export const INITIAL_EASE_FACTOR = 2.5;

export type SrsFields = Pick<Card, "dueAt" | "intervalDays" | "easeFactor" | "reps" | "lapses">;

export function initialSrsFields(now: Date = new Date()): SrsFields {
  return {
    dueAt: now.toISOString(),
    intervalDays: 0,
    easeFactor: INITIAL_EASE_FACTOR,
    reps: 0,
    lapses: 0,
  };
}

function addDays(now: Date, days: number): string {
  const due = new Date(now);
  due.setDate(due.getDate() + days);
  return due.toISOString();
}

/** Applies one review grade to a card's SRS fields, returning the next
 * state. `again` resets the interval and counts as a lapse; `hard`/`good`/
 * `easy` grow the interval by increasing multiples, nudging the ease factor
 * down/unchanged/up respectively. */
export function scheduleReview(fields: SrsFields, grade: ReviewGrade, now: Date = new Date()): SrsFields {
  if (grade === "again") {
    return {
      dueAt: addDays(now, 1),
      intervalDays: 1,
      easeFactor: Math.max(MIN_EASE_FACTOR, fields.easeFactor - 0.2),
      reps: 0,
      lapses: fields.lapses + 1,
    };
  }

  const reps = fields.reps + 1;

  if (grade === "hard") {
    const intervalDays = reps <= 1 ? 1 : Math.max(1, Math.round(fields.intervalDays * 1.2));
    const easeFactor = Math.max(MIN_EASE_FACTOR, fields.easeFactor - 0.15);
    return { dueAt: addDays(now, intervalDays), intervalDays, easeFactor, reps, lapses: fields.lapses };
  }

  if (grade === "good") {
    const intervalDays = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(fields.intervalDays * fields.easeFactor);
    return { dueAt: addDays(now, intervalDays), intervalDays, easeFactor: fields.easeFactor, reps, lapses: fields.lapses };
  }

  // easy
  const intervalDays = reps === 1 ? 2 : reps === 2 ? 8 : Math.round(fields.intervalDays * fields.easeFactor * 1.3);
  const easeFactor = fields.easeFactor + 0.15;
  return { dueAt: addDays(now, intervalDays), intervalDays, easeFactor, reps, lapses: fields.lapses };
}

export function isDue(card: Card, now: Date = new Date()): boolean {
  return new Date(card.dueAt).getTime() <= now.getTime();
}

// Auto-grading layer on top of scheduleReview/ReviewGrade. Replaces the
// review screen's manual again/hard/good/easy self-grading buttons: the
// grade is now derived from whether the typed answer matched the expected
// reading and how long the learner took to answer, instead of asking them
// to judge their own recall.

/** How closely a typed answer matched the expected reading. "near" covers a
 * single-character slip (typo, stray okurigana) so it isn't treated the same
 * as a blank/unrelated answer. */
export type AnswerJudgement = "correct" | "near" | "wrong";

/** Elapsed time (ms) below which a correct answer is graded "easy" — fast
 * recall with no hesitation. */
export const AUTO_EASY_MS = 6000;
/** Elapsed time (ms) below which a correct answer is graded "good" rather
 * than "hard" — recalled without excessive struggle. */
export const AUTO_GOOD_MS = 20000;

function normalizeAnswer(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      // Placeholder marks in pattern-style fronts ("和...聊天", "〜について")
      // count as blanks: learners type a space (or nothing) where the card
      // shows dots/ellipsis/tilde, and that shouldn't read as a wrong answer.
      .replace(/\.{2,}|…+|。{2,}|・{2,}|[~〜]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Minimal Levenshtein edit distance (insert/delete/substitute), used only
 * to detect near-miss typos — no need for a full diff, just a distance. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[rows - 1][cols - 1];
}

/** Compares a typed answer against the expected reading, normalizing both
 * (NFKC, trim, lowercase, collapsed whitespace) before comparing. A blank
 * typed answer is always "wrong"; an exact match is "correct"; anything
 * within edit distance 1 of a reasonably long expected string (>= 4 chars)
 * is treated as a "near" miss (typo) rather than a wrong answer. */
export function judgeAnswer(typed: string, expected: string): AnswerJudgement {
  const normalizedTyped = normalizeAnswer(typed);
  const normalizedExpected = normalizeAnswer(expected);

  if (normalizedTyped.length === 0) return "wrong";
  if (normalizedTyped === normalizedExpected) return "correct";

  if (normalizedExpected.length >= 4 && levenshteinDistance(normalizedTyped, normalizedExpected) <= 1) {
    return "near";
  }

  return "wrong";
}

/** Maps an answer judgement + response time to a `ReviewGrade` for
 * `scheduleReview`. A wrong answer always lapses ("again"); a near-miss
 * typo is treated as a partial recall ("hard"); a correct answer is graded
 * by speed as a rough proxy for recall fluency — fast is "easy", moderate
 * is "good", slow (hesitant) recall is only "hard". */
export function autoGrade(judgement: AnswerJudgement, elapsedMs: number): ReviewGrade {
  if (judgement === "wrong") return "again";
  if (judgement === "near") return "hard";
  if (elapsedMs <= AUTO_EASY_MS) return "easy";
  if (elapsedMs <= AUTO_GOOD_MS) return "good";
  return "hard";
}
