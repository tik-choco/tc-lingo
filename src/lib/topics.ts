// Topic + PracticeAttempt CRUD. Persistence keys: tc-lingo:topics-v1,
// tc-lingo:attempts-v1. Same-topic repeated practice (round 1/2/3) is the
// core differentiator this app is built around — see CLAUDE.md.
import type { AttemptRound, PracticeAttempt, Topic } from "../types";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";

const TOPICS_NAME = "topics-v1";
const ATTEMPTS_NAME = "attempts-v1";

function isTopic(value: unknown): value is Topic {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.prompt === "string" &&
    typeof r.custom === "boolean" &&
    (r.language === undefined || typeof r.language === "string") &&
    typeof r.createdAt === "string"
  );
}

function isAttempt(value: unknown): value is PracticeAttempt {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.topicId === "string" &&
    (r.round === 1 || r.round === 2 || r.round === 3) &&
    typeof r.createdAt === "string" &&
    typeof r.original === "string" &&
    typeof r.corrected === "string" &&
    typeof r.reasons === "string" &&
    typeof r.retryPrompt === "string" &&
    typeof r.retryAnswer === "string" &&
    (r.retryCorrected === undefined || typeof r.retryCorrected === "string") &&
    (r.retryReasons === undefined || typeof r.retryReasons === "string")
  );
}

/** `language`, when given, also matches topics saved with "" (unassigned,
 * predating multi-language support) so they aren't orphaned out of view. */
export function loadTopics(language?: string): Topic[] {
  const raw = loadJson<unknown[]>(TOPICS_NAME, []);
  const topics = Array.isArray(raw) ? raw.filter(isTopic).map((t) => ({ ...t, language: t.language ?? "" })) : [];
  return language ? topics.filter((t) => t.language === language || t.language === "") : topics;
}

function saveTopics(topics: Topic[]): void {
  saveJson(TOPICS_NAME, topics);
}

/** `retryCorrected`/`retryReasons` predate the retry-check feature on some
 * saved attempts — backfilled to "" (unchecked) rather than dropped, same
 * pattern as cards.ts's `language` backfill. */
export function loadAttempts(): PracticeAttempt[] {
  const raw = loadJson<unknown[]>(ATTEMPTS_NAME, []);
  return Array.isArray(raw)
    ? raw.filter(isAttempt).map((a) => ({ ...a, retryCorrected: a.retryCorrected ?? "", retryReasons: a.retryReasons ?? "" }))
    : [];
}

function saveAttempts(attempts: PracticeAttempt[]): void {
  saveJson(ATTEMPTS_NAME, attempts);
}

export function subscribeTopics(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export function addTopic(input: { title: string; prompt: string; custom: boolean; language?: string }): Topic {
  const topic: Topic = {
    id: newId(),
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    custom: input.custom,
    language: input.language ?? "",
    createdAt: new Date().toISOString(),
  };
  saveTopics([topic, ...loadTopics()]);
  return topic;
}

export function deleteTopic(id: string): void {
  saveTopics(loadTopics().filter((t) => t.id !== id));
  saveAttempts(loadAttempts().filter((a) => a.topicId !== id));
}

export function attemptsForTopic(topicId: string): PracticeAttempt[] {
  return loadAttempts()
    .filter((a) => a.topicId === topicId)
    .sort((a, b) => a.round - b.round);
}

/** Next round to record for a topic: 1 if there's no attempt yet, otherwise
 * one past the highest existing round, capped at 3 (round 3 is the final
 * "翌日再挑戦" slot — the UI doesn't enforce that it actually happens the
 * next calendar day, it's just the intended cadence). Returns null once a
 * topic already has all three rounds. */
export function nextRoundFor(topicId: string): AttemptRound | null {
  const rounds = attemptsForTopic(topicId).map((a) => a.round);
  if (rounds.length === 0) return 1;
  const highest = Math.max(...rounds);
  return highest >= 3 ? null : ((highest + 1) as AttemptRound);
}

export interface NewAttemptInput {
  topicId: string;
  round: AttemptRound;
  original: string;
  corrected?: string;
  reasons?: string;
  retryPrompt?: string;
  retryAnswer?: string;
  retryCorrected?: string;
  retryReasons?: string;
}

export function addAttempt(input: NewAttemptInput): PracticeAttempt {
  const attempt: PracticeAttempt = {
    id: newId(),
    topicId: input.topicId,
    round: input.round,
    createdAt: new Date().toISOString(),
    original: input.original,
    corrected: input.corrected ?? "",
    reasons: input.reasons ?? "",
    retryPrompt: input.retryPrompt ?? "",
    retryAnswer: input.retryAnswer ?? "",
    retryCorrected: input.retryCorrected ?? "",
    retryReasons: input.retryReasons ?? "",
  };
  saveAttempts([...loadAttempts(), attempt]);
  return attempt;
}

export function updateAttempt(id: string, patch: Partial<Omit<NewAttemptInput, "topicId" | "round">>): void {
  const attempts = loadAttempts().map((a) => (a.id === id ? { ...a, ...patch } : a));
  saveAttempts(attempts);
}
