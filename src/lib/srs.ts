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
