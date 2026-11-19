import { afterEach, expect, it, vi } from "vitest";
import { addCard, boostCardPriority, gradeCard, loadCards, sanitizeCards, setAutoCardPriority, setCardPriority } from "../src/lib/cards";
import { loadReviewDaily } from "../src/lib/reviewDaily";
import { buildReviewQueue } from "../src/lib/reviewQueue";
import type { Card } from "../src/types";

const now = new Date(2026, 10, 19, 23, 55);
const date = now.toISOString();
const dayMs = 86_400_000;

function card(id: string, patch: Partial<Card> = {}): Card {
  return {
    id, front: id, reading: "", meaning: id, exampleSentence: "", exampleSentenceTranslation: "",
    cloze: "", context: "", source: "manual", sourceTopicId: null, language: "English",
    priority: 0.5, prioritySource: "default", suspended: false, lastReviewedAt: null, createdAt: date, updatedAt: date,
    dueAt: date, reps: 0, lapses: 0, intervalDays: 0, easeFactor: 2.5,
    ...patch,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("orders eligible reviews by urgency and interleaves the highest priority new cards", () => {
  const overdue = new Date(now.getTime() - 2 * dayMs).toISOString();
  const cards = [
    card("less-urgent", { reps: 1, intervalDays: 4 }),
    card("new-normal"),
    card("same-urgency-due-later", { reps: 1, intervalDays: 1, priority: 1 }),
    card("wrong-language", { language: "Japanese" }),
    card("urgent", { dueAt: overdue, lapses: 4, intervalDays: 1, priority: 0.2 }),
    card("suspended", { suspended: true, priority: 1 }),
    card("new-high", { priority: 0.8, language: "" }),
    card("same-urgency-due-earlier", { dueAt: overdue, lastReviewedAt: date, intervalDays: 4 }),
    card("new-high-older", { priority: 0.8, createdAt: overdue }),
    card("future", { dueAt: new Date(now.getTime() + dayMs).toISOString() }),
  ];
  const { queue, deferred } = buildReviewQueue(cards, now, {
    language: "English", sessionLimit: 6, newRemainingToday: 2,
  });
  expect(queue.map(({ id }) => id)).toEqual([
    "urgent", "same-urgency-due-earlier", "same-urgency-due-later", "new-high-older", "less-urgent", "new-high",
  ]);
  expect(deferred).toBe(1);
});

it("applies the session cap when the daily new-card allowance is larger", () => {
  const cards = Array.from({ length: 8 }, (_, i) => card(String(i)));
  const { queue, deferred } = buildReviewQueue(cards, now, { sessionLimit: 5, newRemainingToday: 10 });
  expect(queue).toHaveLength(5);
  expect(deferred).toBe(3);
});

it("counts only the first grade as an introduction and resets at local midnight", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", new EventTarget());
  const { id } = addCard({ front: "train", meaning: "railway vehicle" });

  gradeCard(id, "again", now);
  gradeCard(id, "again", now);
  expect(loadCards()[0]).toMatchObject({ lapses: 2, lastReviewedAt: date });
  expect(loadReviewDaily(now)).toEqual({ date: "2026-11-19", newIntroduced: 1 });
  const midnight = new Date(2026, 10, 20);
  expect(loadReviewDaily(midnight)).toEqual({ date: "2026-11-20", newIntroduced: 0 });
});

it("normalizes legacy and out-of-range priority without changing revisions", () => {
  const { priority, prioritySource, suspended, lastReviewedAt, ...legacy } = card("legacy");
  expect(sanitizeCards([legacy, { ...legacy, priority: Infinity }, { ...legacy, priority: 2 }])).toEqual([
    { ...legacy, priority, prioritySource, suspended, lastReviewedAt },
    { ...legacy, priority, prioritySource, suspended, lastReviewedAt },
    { ...legacy, priority: 1, prioritySource, suspended, lastReviewedAt },
  ]);
});

it("keeps manual priority edits made while automatic scoring is in flight", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
  const pending = addCard({ front: "train", meaning: "railway vehicle" });
  const auto = setAutoCardPriority(pending, 0.8);
  expect(auto).toMatchObject({ priority: 0.8, prioritySource: "auto" });
  expect(setCardPriority(pending.id, 0.2)).toMatchObject({ priority: 0.2, prioritySource: "user" });
  const boosted = boostCardPriority(pending.id, 0.05);
  expect(boosted).toMatchObject({ priority: 0.25, prioritySource: "user" });
  expect(setAutoCardPriority(pending, 0.9)).toBeNull();
  expect(loadCards()[0]).toEqual(boosted);
});
