import { loadJson } from "./storage";
import { localDateKey } from "./activityLog";

// Device-local, outside the P2P and Vault store lists.
export const REVIEW_DAILY_STORAGE = "review-daily-v1";

export function loadReviewDaily(now: Date): { date: string; newIntroduced: number } {
  const date = localDateKey(now);
  const saved = loadJson<{ date?: unknown; newIntroduced?: unknown } | null>(REVIEW_DAILY_STORAGE, null);
  const count = saved?.newIntroduced;
  const newIntroduced = saved?.date === date && typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : 0;
  return { date, newIntroduced };
}
