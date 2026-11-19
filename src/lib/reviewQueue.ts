import type { Card } from "../types";
import { isDue } from "./srs";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isNewCard(card: Card): boolean {
  return card.reps === 0 && card.lapses === 0 && card.lastReviewedAt == null;
}

export function isDueForReview(card: Card, now: Date, language?: string): boolean {
  return !card.suspended && isDue(card, now) && (!language || card.language === language || card.language === "");
}

export function buildReviewQueue(
  cards: readonly Card[],
  now: Date,
  { language, sessionLimit, newRemainingToday }: { language?: string; sessionLimit: number; newRemainingToday: number },
): { queue: Card[]; deferred: number } {
  const newCards: Card[] = [];
  const reviews: { card: Card; dueAt: number; urgency: number }[] = [];
  for (const card of cards) {
    if (!isDueForReview(card, now, language)) continue;
    if (isNewCard(card)) {
      newCards.push(card);
      continue;
    }
    const dueAt = Date.parse(card.dueAt);
    const overdueDays = (now.getTime() - dueAt) / DAY_MS;
    const urgency = (0.5 + card.priority)
      * (1 + Math.min(overdueDays / Math.max(card.intervalDays, 1), 2))
      * (1 + 0.15 * Math.min(card.lapses, 4));
    reviews.push({ card, dueAt, urgency });
  }
  reviews.sort((a, b) => b.urgency - a.urgency || a.dueAt - b.dueAt);
  newCards.sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));

  // The session limit applies even when the remaining daily allowance is larger.
  const newTake = Math.min(Math.max(0, newRemainingToday), newCards.length, sessionLimit);
  const reviewTake = Math.min(reviews.length, Math.max(0, sessionLimit - newTake));
  const queue: Card[] = [];
  let newIndex = 0;
  for (let i = 0; i < reviewTake; i++) {
    queue.push(reviews[i].card);
    if ((i + 1) % 3 === 0 && newIndex < newTake) queue.push(newCards[newIndex++]);
  }
  queue.push(...newCards.slice(newIndex, newTake));
  return { queue, deferred: reviews.length + newCards.length - queue.length };
}
