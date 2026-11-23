import type { Card } from "../types";
import { loadJson, saveJson, storageKey } from "./storage";

// Device-local, outside the P2P sync and Vault store lists.
export const REVIEW_ACTIVITY_STORAGE = "review-activity-v1";
const RETENTION_DAYS = 400;

export interface ReviewActivity {
  v: 1;
  days: Record<string, Record<string, number>>;
}

type SeedCard = Pick<Card, "lastReviewedAt" | "language">;

export function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyActivity(): ReviewActivity {
  return { v: 1, days: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key;
}

function readActivity(): ReviewActivity | null {
  const raw = loadJson<unknown>(REVIEW_ACTIVITY_STORAGE, undefined);
  if (raw === undefined) {
    try {
      // Only an absent key triggers seeding. loadJson also falls back on invalid JSON.
      if (localStorage.getItem(storageKey(REVIEW_ACTIVITY_STORAGE)) === null) return null;
    } catch {
      return emptyActivity();
    }
  }
  const activity = emptyActivity();
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.days)) return activity;
  for (const [key, counts] of Object.entries(raw.days)) {
    if (!isDateKey(key) || !isRecord(counts)) continue;
    const valid = emptyLanguageCounts();
    for (const [language, count] of Object.entries(counts)) {
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) valid[language] = count;
    }
    if (Object.keys(valid).length) activity.days[key] = valid;
  }
  return activity;
}

function emptyLanguageCounts(): Record<string, number> {
  // Language names are arbitrary strings, including legacy unassigned cards ("").
  return Object.create(null) as Record<string, number>;
}

function increment(activity: ReviewActivity, day: string, language: string): void {
  const counts = activity.days[day] ??= emptyLanguageCounts();
  counts[language] = Math.min((counts[language] ?? 0) + 1, Number.MAX_SAFE_INTEGER);
}

function seedActivity(cards: readonly SeedCard[]): ReviewActivity {
  const activity = emptyActivity();
  for (const { lastReviewedAt, language } of cards) {
    if (!lastReviewedAt) continue;
    const date = new Date(lastReviewedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const key = localDateKey(date);
    if (isDateKey(key)) increment(activity, key, language);
  }
  return activity;
}

function pruneActivity(activity: ReviewActivity, now: Date): void {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const first = localDateKey(cutoff);
  for (const key of Object.keys(activity.days)) {
    if (key < first) delete activity.days[key];
  }
}

/** Pass a lazy card loader when opening History to seed and persist a missing log. */
export function loadReviewActivity(loadCards?: () => readonly SeedCard[], now = new Date()): ReviewActivity {
  const saved = readActivity();
  if (saved) return saved;
  if (!loadCards) return emptyActivity();
  const activity = seedActivity(loadCards());
  pruneActivity(activity, now);
  saveJson(REVIEW_ACTIVITY_STORAGE, activity);
  return activity;
}

/** Prepare the next log for the caller's card-write batch, including any initial seed. */
export function nextReviewActivity(cards: readonly SeedCard[], language: string, now: Date): ReviewActivity {
  const activity = readActivity() ?? seedActivity(cards);
  increment(activity, localDateKey(now), language);
  pruneActivity(activity, now);
  return activity;
}
