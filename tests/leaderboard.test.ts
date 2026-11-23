import { describe, expect, it } from "vitest";
import { localDateKey } from "../src/lib/activityLog";
import { decodeLeaderboard, encodeLeaderboard } from "../src/lib/leaderboard/protocol";
import type { LeaderboardMessage } from "../src/lib/leaderboard/protocol";
import { computeLeaderboardStats } from "../src/lib/leaderboard/stats";
import type { ConversationTurn } from "../src/types";

const statsMessage = {
  type: "lingo_rank_stats",
  v: 1,
  name: "学習者",
  language: "Japanese",
  stats: { today: 5, week: 12, month: 24, streak: 3, activeDays: 15 },
  sentAt: 1_790_000_000_000,
} satisfies LeaderboardMessage;

describe("leaderboard protocol", () => {
  it("round-trips hello and UTF-8 stats messages", () => {
    const hello = { type: "lingo_rank_hello", v: 1 } as const;
    expect(decodeLeaderboard(encodeLeaderboard(hello))).toEqual(hello);
    expect(decodeLeaderboard(encodeLeaderboard(statsMessage))).toEqual(statsMessage);
  });

  it.each([
    "invalid JSON",
    "null",
    "[]",
    JSON.stringify({ type: "llm_request", v: 1 }),
    JSON.stringify({ type: "lingo_rank_hello", v: 2 }),
    JSON.stringify({ ...statsMessage, name: 12 }),
    JSON.stringify({ ...statsMessage, language: null }),
    JSON.stringify({ ...statsMessage, sentAt: undefined }),
    JSON.stringify({ ...statsMessage, stats: [] }),
    JSON.stringify({ ...statsMessage, stats: { ...statsMessage.stats, today: "5" } }),
    JSON.stringify({ ...statsMessage, stats: { ...statsMessage.stats, streak: undefined } }),
    new Uint8Array([0xc3, 0x28]),
  ])("rejects malformed or unrelated messages (%s)", (payload) => {
    expect(decodeLeaderboard(payload)).toBeNull();
  });

  it("clamps numeric fields and trims and bounds text", () => {
    const message = {
      ...statsMessage,
      name: `  ${"学".repeat(40)}  `,
      language: `  ${"a".repeat(70)}  `,
      stats: { today: -10, week: 12.9, month: 1e25, streak: -0.5, activeDays: 15 },
      sentAt: -1,
    };
    expect(decodeLeaderboard(encodeLeaderboard(message))).toEqual({
      ...statsMessage,
      name: "学".repeat(32),
      language: "a".repeat(64),
      stats: { today: 0, week: 12, month: Number.MAX_SAFE_INTEGER, streak: 0, activeDays: 15 },
      sentAt: 0,
    });
    expect(decodeLeaderboard(encodeLeaderboard({ ...statsMessage, name: "  " }))).toEqual({ ...statsMessage, name: "" });
  });
});

const today = new Date(2026, 10, 23, 12);

function daysAgo(days: number): Date {
  const date = new Date(today);
  date.setDate(date.getDate() - days);
  return date;
}

function turn(role: ConversationTurn["role"]): ConversationTurn {
  return {
    id: role,
    role,
    text: "",
    reading: "",
    translation: "",
    corrected: "",
    correctedReading: "",
    correctedTranslation: "",
    reasons: "",
    understanding: "",
    unclearReason: "",
    revealedFactIds: [],
  };
}

describe("leaderboard stats", () => {
  it("counts all study languages and honors the inclusive period boundaries", () => {
    const stats = computeLeaderboardStats({
      reviews: {
        [localDateKey(daysAgo(-1))]: { Japanese: 25 },
        [localDateKey(today)]: { Japanese: 2, Spanish: 3 },
        [localDateKey(daysAgo(1))]: { Japanese: 4 },
        [localDateKey(daysAgo(6))]: { Spanish: 6 },
        [localDateKey(daysAgo(7))]: { Spanish: 7 },
        [localDateKey(daysAgo(29))]: { Japanese: 29 },
        [localDateKey(daysAgo(30))]: { Japanese: 30 },
        [localDateKey(daysAgo(364))]: { Spanish: 1 },
        [localDateKey(daysAgo(365))]: { Spanish: 2 },
      },
      topics: [{ id: "topic", language: "French" }],
      attempts: [{ topicId: "topic", createdAt: today.toISOString() }],
      passages: [{ language: "English", createdAt: daysAgo(2).toISOString() }],
      conversations: [{
        language: "Italian",
        createdAt: today.toISOString(),
        turns: [turn("learner"), turn("assistant"), turn("learner")],
      }],
    }, today);
    expect(stats).toEqual({ today: 8, week: 19, month: 55, streak: 3, activeDays: 8 });
  });

  it("keeps yesterday's streak until today ends", () => {
    const stats = computeLeaderboardStats({
      reviews: {
        [localDateKey(daysAgo(1))]: { Japanese: 1 },
        [localDateKey(daysAgo(2))]: { Spanish: 1 },
      },
      topics: [],
      attempts: [],
      passages: [],
      conversations: [],
    }, today);
    expect(stats).toEqual({ today: 0, week: 2, month: 2, streak: 2, activeDays: 2 });
  });
});
