export interface LeaderboardStats {
  today: number;
  week: number;
  month: number;
  streak: number;
  activeDays: number;
}

export type LeaderboardMessage =
  | { type: "lingo_rank_hello"; v: 1 }
  | { type: "lingo_rank_stats"; v: 1; name: string; language: string; stats: LeaderboardStats; sentAt: number };

export const LEADERBOARD_NAME_MAX_LENGTH = 32;
const LANGUAGE_MAX_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function normalizeLeaderboardName(name: unknown): string {
  return typeof name === "string" ? name.trim().slice(0, LEADERBOARD_NAME_MAX_LENGTH).trimEnd() : "";
}

export function normalizeLeaderboardLanguage(language: string): string {
  return language.trim().slice(0, LANGUAGE_MAX_LENGTH).trimEnd();
}

export function clampCount(value: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function encodeLeaderboard(message: LeaderboardMessage): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}

export function decodeLeaderboard(payload: Uint8Array | string): LeaderboardMessage | null {
  if (payload.length > MAX_MESSAGE_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
    if (!isRecord(value) || value.v !== 1) return null;
    if (value.type === "lingo_rank_hello") return { type: value.type, v: 1 };
    if (value.type !== "lingo_rank_stats" || typeof value.name !== "string" ||
        typeof value.language !== "string" || typeof value.sentAt !== "number" || !isRecord(value.stats)) return null;

    const { today, week, month, streak, activeDays } = value.stats;
    if (typeof today !== "number" || typeof week !== "number" || typeof month !== "number" ||
        typeof streak !== "number" || typeof activeDays !== "number") return null;
    return {
      type: value.type,
      v: 1,
      name: normalizeLeaderboardName(value.name),
      language: normalizeLeaderboardLanguage(value.language),
      stats: {
        today: clampCount(today),
        week: clampCount(week),
        month: clampCount(month),
        streak: clampCount(streak),
        activeDays: clampCount(activeDays),
      },
      sentAt: clampCount(value.sentAt),
    };
  } catch {
    return null;
  }
}
