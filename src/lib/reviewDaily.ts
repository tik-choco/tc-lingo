import { loadJson } from "./storage";

// Device-local, outside the P2P and Vault store lists.
export const REVIEW_DAILY_STORAGE = "review-daily-v1";

export function loadReviewDaily(now: Date): { date: string; newIntroduced: number } {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const saved = loadJson<{ date?: unknown; newIntroduced?: unknown } | null>(REVIEW_DAILY_STORAGE, null);
  const count = saved?.newIntroduced;
  const newIntroduced = saved?.date === date && typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : 0;
  return { date, newIntroduced };
}
