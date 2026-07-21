// Topic + PracticeAttempt CRUD. Persistence keys: tc-lingo:topics-v1,
// tc-lingo:attempts-v1. Same-topic repeated practice (round 1/2/3) is the
// core differentiator this app is built around — see CLAUDE.md.
import type { AttemptRound, PracticeAttempt, Topic } from "../types";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";
import { recordTombstone } from "./sync/tombstones";

const TOPICS_NAME = "topics-v1";
const ATTEMPTS_NAME = "attempts-v1";

/** Exported so lib/sync/snapshot.ts can validate remote topics with the
 * exact same rules used to load local ones. `updatedAt` is optional here to
 * accept topics saved before the sync feature existed — see sanitizeTopics. */
export function isTopic(value: unknown): value is Topic {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.prompt === "string" &&
    (r.promptTranslation === undefined || typeof r.promptTranslation === "string") &&
    typeof r.custom === "boolean" &&
    (r.language === undefined || typeof r.language === "string") &&
    typeof r.createdAt === "string" &&
    (r.updatedAt === undefined || typeof r.updatedAt === "string")
  );
}

/** Same optional-`updatedAt` convention as isTopic — see sanitizeAttempts. */
export function isAttempt(value: unknown): value is PracticeAttempt {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.topicId === "string" &&
    (r.round === 1 || r.round === 2 || r.round === 3) &&
    typeof r.createdAt === "string" &&
    typeof r.original === "string" &&
    typeof r.corrected === "string" &&
    (r.correctedReading === undefined || typeof r.correctedReading === "string") &&
    (r.correctedTranslation === undefined || typeof r.correctedTranslation === "string") &&
    typeof r.reasons === "string" &&
    typeof r.retryPrompt === "string" &&
    (r.retryPromptReading === undefined || typeof r.retryPromptReading === "string") &&
    (r.retryPromptTranslation === undefined || typeof r.retryPromptTranslation === "string") &&
    typeof r.retryAnswer === "string" &&
    (r.retryCorrected === undefined || typeof r.retryCorrected === "string") &&
    (r.retryCorrectedReading === undefined || typeof r.retryCorrectedReading === "string") &&
    (r.retryCorrectedTranslation === undefined || typeof r.retryCorrectedTranslation === "string") &&
    (r.retryReasons === undefined || typeof r.retryReasons === "string") &&
    (r.updatedAt === undefined || typeof r.updatedAt === "string")
  );
}

/** Filters + backfills a raw array into valid Topics: `language` predates
 * multi-language support (backfilled to ""); `promptTranslation` predates
 * the translation-reveal feature (backfilled to ""); `updatedAt` predates
 * the sync feature (backfilled to `createdAt`, same rationale as cards.ts's
 * sanitizeCards). Exported so lib/sync/snapshot.ts can apply identical
 * sanitization to a remote snapshot's topics. */
export function sanitizeTopics(raw: unknown): Topic[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTopic).map((t) => ({
    ...t,
    language: t.language ?? "",
    promptTranslation: t.promptTranslation ?? "",
    updatedAt: t.updatedAt ?? t.createdAt,
  }));
}

/** `retryCorrected`/`retryReasons` predate the retry-check feature on some
 * saved attempts — backfilled to "" (unchecked) rather than dropped, same
 * pattern as cards.ts's `language` backfill. `correctedReading`/
 * `retryPromptReading`/`retryCorrectedReading` predate the always-visible
 * reading-aid feature (lib/languages.ts readingAid) — backfilled to "" the
 * same way. `updatedAt` predates the sync feature — backfilled to
 * `createdAt`, same rationale as cards.ts's sanitizeCards. Exported so
 * lib/sync/snapshot.ts can apply identical sanitization to a remote
 * snapshot's attempts. */
export function sanitizeAttempts(raw: unknown): PracticeAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAttempt).map((a) => ({
    ...a,
    correctedReading: a.correctedReading ?? "",
    correctedTranslation: a.correctedTranslation ?? "",
    retryPromptReading: a.retryPromptReading ?? "",
    retryPromptTranslation: a.retryPromptTranslation ?? "",
    retryCorrected: a.retryCorrected ?? "",
    retryCorrectedReading: a.retryCorrectedReading ?? "",
    retryCorrectedTranslation: a.retryCorrectedTranslation ?? "",
    retryReasons: a.retryReasons ?? "",
    updatedAt: a.updatedAt ?? a.createdAt,
  }));
}

/** `language`, when given, also matches topics saved with "" (unassigned,
 * predating multi-language support) so they aren't orphaned out of view. */
export function loadTopics(language?: string): Topic[] {
  const topics = sanitizeTopics(loadJson<unknown[]>(TOPICS_NAME, []));
  return language ? topics.filter((t) => t.language === language || t.language === "") : topics;
}

function saveTopics(topics: Topic[]): void {
  saveJson(TOPICS_NAME, topics);
}

export function loadAttempts(): PracticeAttempt[] {
  return sanitizeAttempts(loadJson<unknown[]>(ATTEMPTS_NAME, []));
}

function saveAttempts(attempts: PracticeAttempt[]): void {
  saveJson(ATTEMPTS_NAME, attempts);
}

export function subscribeTopics(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export function addTopic(input: {
  title: string;
  prompt: string;
  promptTranslation?: string;
  custom: boolean;
  language?: string;
}): Topic {
  const now = new Date().toISOString();
  const topic: Topic = {
    id: newId(),
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    promptTranslation: input.promptTranslation?.trim() ?? "",
    custom: input.custom,
    language: input.language ?? "",
    createdAt: now,
    updatedAt: now,
  };
  saveTopics([topic, ...loadTopics()]);
  return topic;
}

export function deleteTopic(id: string): void {
  const orphanedAttemptIds = loadAttempts()
    .filter((a) => a.topicId === id)
    .map((a) => a.id);
  saveTopics(loadTopics().filter((t) => t.id !== id));
  saveAttempts(loadAttempts().filter((a) => a.topicId !== id));
  recordTombstone("topics", id);
  // The topic's attempts are deleted alongside it (see saveAttempts filter
  // above) — record a tombstone for each so a peer that still has one of
  // them removes it too instead of resurrecting it on the next sync.
  for (const attemptId of orphanedAttemptIds) recordTombstone("attempts", attemptId);
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
  correctedReading?: string;
  correctedTranslation?: string;
  reasons?: string;
  retryPrompt?: string;
  retryPromptReading?: string;
  retryPromptTranslation?: string;
  retryAnswer?: string;
  retryCorrected?: string;
  retryCorrectedReading?: string;
  retryCorrectedTranslation?: string;
  retryReasons?: string;
}

export function addAttempt(input: NewAttemptInput): PracticeAttempt {
  const now = new Date().toISOString();
  const attempt: PracticeAttempt = {
    id: newId(),
    topicId: input.topicId,
    round: input.round,
    createdAt: now,
    original: input.original,
    corrected: input.corrected ?? "",
    correctedReading: input.correctedReading ?? "",
    correctedTranslation: input.correctedTranslation ?? "",
    reasons: input.reasons ?? "",
    retryPrompt: input.retryPrompt ?? "",
    retryPromptReading: input.retryPromptReading ?? "",
    retryPromptTranslation: input.retryPromptTranslation ?? "",
    retryAnswer: input.retryAnswer ?? "",
    retryCorrected: input.retryCorrected ?? "",
    retryCorrectedReading: input.retryCorrectedReading ?? "",
    retryCorrectedTranslation: input.retryCorrectedTranslation ?? "",
    retryReasons: input.retryReasons ?? "",
    updatedAt: now,
  };
  saveAttempts([...loadAttempts(), attempt]);
  return attempt;
}

export function updateAttempt(id: string, patch: Partial<Omit<NewAttemptInput, "topicId" | "round">>): void {
  const now = new Date().toISOString();
  const attempts = loadAttempts().map((a) => (a.id === id ? { ...a, ...patch, updatedAt: now } : a));
  saveAttempts(attempts);
}

/** Bulk-replaces the entire topic store with `topics` (one save, one change
 * event) — persistence only, no id lookup/merge. Only lib/sync/snapshot.ts
 * should call this; every other write path goes through addTopic/deleteTopic
 * above so `updatedAt`/tombstones stay correct. */
export function replaceTopicsForSync(topics: Topic[]): void {
  saveTopics(topics);
}

/** Bulk-replaces the entire attempt store with `attempts` (one save, one
 * change event) — persistence only, no id lookup/merge. Only
 * lib/sync/snapshot.ts should call this; every other write path goes through
 * addAttempt/updateAttempt above so `updatedAt`/tombstones stay correct. */
export function replaceAttemptsForSync(attempts: PracticeAttempt[]): void {
  saveAttempts(attempts);
}
