import type {
  Card, ConversationSession, ConversationTurn, LanguageLevelRecord, PracticeAttempt, ReadingPassage, Topic,
} from "../../types";
import { isCard } from "../cards";
import { isConversationSession } from "../conversation";
import { isLevelRecord } from "../level";
import { isReadingPassage } from "../reading";
import { legacyBaseline, subscribeStorageChanges } from "../storage";
import { buildSyncSnapshot, mergeStore, replaceSyncSnapshot } from "../sync/snapshot";
import { pruneTombstones, unionTombstones } from "../sync/tombstones";
import type { SyncSnapshot, SyncStoreName, Tombstone } from "../sync/types";
import { isAttempt, isTopic } from "../topics";
import type { VaultAdapter } from "./types";

export type VaultState = SyncSnapshot;

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_STRING_LENGTH = 2 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_NESTED_ITEMS = 10_000;

const CARD_KEYS = ["id", "front", "reading", "meaning", "exampleSentence", "exampleSentenceTranslation", "context", "cloze", "source", "sourceTopicId", "language", "createdAt", "dueAt", "intervalDays", "easeFactor", "reps", "lapses", "updatedAt"] as const satisfies readonly (keyof Card)[];
const TOPIC_KEYS = ["id", "title", "prompt", "promptTranslation", "custom", "language", "createdAt", "updatedAt"] as const satisfies readonly (keyof Topic)[];
const ATTEMPT_KEYS = ["id", "topicId", "round", "createdAt", "original", "corrected", "correctedReading", "correctedTranslation", "reasons", "retryPrompt", "retryPromptReading", "retryPromptTranslation", "retryAnswer", "retryCorrected", "retryCorrectedReading", "retryCorrectedTranslation", "retryReasons", "updatedAt"] as const satisfies readonly (keyof PracticeAttempt)[];
const PASSAGE_KEYS = ["id", "language", "title", "sentences", "reviewWords", "question", "questionAnswer", "createdAt", "updatedAt"] as const satisfies readonly (keyof ReadingPassage)[];
const SENTENCE_KEYS = ["text", "translation", "reading"] as const;
const CONVERSATION_KEYS = ["id", "language", "title", "scenario", "turns", "createdAt", "endedAt", "updatedAt"] as const satisfies readonly (keyof ConversationSession)[];
const TURN_KEYS = ["id", "role", "text", "reading", "translation", "corrected", "correctedReading", "correctedTranslation", "reasons"] as const satisfies readonly (keyof ConversationTurn)[];
const LEVEL_KEYS = ["language", "score", "samples", "override", "updatedAt"] as const satisfies readonly (keyof LanguageLevelRecord)[];
const TOMBSTONE_KEYS = ["store", "id", "deletedAt"] as const satisfies readonly (keyof Tombstone)[];
const STATE_KEYS = ["v", "app", "cards", "topics", "attempts", "passages", "conversations", "levels", "tombstones"] as const;
const STORE_NAMES: SyncStoreName[] = ["cards", "topics", "attempts", "passages", "conversations", "levels"];
const STORAGE_NAMES = new Set(["cards-v1", "topics-v1", "attempts-v1", "passages-v1", "conversations-v1", "levels-v1", "sync-tombstones-v1"]);

function invalid(): never {
  throw new Error("Invalid vault checkpoint");
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasKeys(value: unknown, keys: readonly string[]): boolean {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0 && id.length <= 512;
}

function validDate(value: unknown, ceiling: number): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && time >= 0 && time <= ceiling && new Date(time).toISOString() === value;
}

function validateJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 1_000_000 || depth > 8) invalid();
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) invalid();
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
  } else if (Array.isArray(value)) {
    if (value.length > MAX_RECORDS) invalid();
    for (const item of value) validateJson(item, depth + 1, budget);
  } else if (record(value)) {
    const entries = Object.entries(value);
    if (entries.length > 100) invalid();
    for (const [key, item] of entries) {
      if (key.length > 512) invalid();
      validateJson(item, depth + 1, budget);
    }
  } else if (value !== null && typeof value !== "boolean") {
    invalid();
  }
}

function unique<T>(items: T[], keyOf: (item: T) => string): void {
  const keys = new Set(items.map(keyOf));
  if (keys.size !== items.length) invalid();
}

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = value[key];
  return result;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byCreated<T extends { id: string; createdAt: string }>(newestFirst: boolean): (a: T, b: T) => number {
  return (a, b) => (newestFirst ? compare(b.createdAt, a.createdAt) : compare(a.createdAt, b.createdAt)) || compare(a.id, b.id);
}

/** Project the domain fields explicitly; unrelated properties never enter a checkpoint. */
function project(state: SyncSnapshot): VaultState {
  return {
    v: 1,
    app: "tc-lingo",
    cards: state.cards.map((item) => pick(item, CARD_KEYS)).sort(byCreated(false)),
    topics: state.topics.map((item) => pick(item, TOPIC_KEYS)).sort(byCreated(true)),
    attempts: state.attempts.map((item) => pick(item, ATTEMPT_KEYS)).sort(byCreated(false)),
    passages: state.passages.map((item) => ({
      ...pick(item, PASSAGE_KEYS), sentences: item.sentences.map((sentence) => pick(sentence, SENTENCE_KEYS)),
    })).sort(byCreated(true)),
    conversations: state.conversations.map((item) => ({
      ...pick(item, CONVERSATION_KEYS), turns: item.turns.map((turn) => pick(turn, TURN_KEYS)),
    })).sort(byCreated(true)),
    levels: state.levels.map((item) => pick(item, LEVEL_KEYS)).sort((a, b) => compare(a.language, b.language)),
    tombstones: unionTombstones([], state.tombstones.map((item) => pick(item, TOMBSTONE_KEYS))),
  };
}

function parseState(value: unknown, ceiling = Date.now() + 366 * 86400000): VaultState {
  const date = (value: unknown) => validDate(value, ceiling);
  // Due dates are planned events and may exceed the revision clock limit.
  const dueDate = (value: unknown) => validDate(value, Infinity);
  validateJson(value);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES || !hasKeys(value, STATE_KEYS) || !record(value)) invalid();
  if (value.v !== 1 || value.app !== "tc-lingo") invalid();
  const arrays = [value.cards, value.topics, value.attempts, value.passages, value.conversations, value.levels, value.tombstones];
  if (arrays.some((items) => !Array.isArray(items)) || arrays.reduce<number>((count, items) => count + (items as unknown[]).length, 0) > MAX_RECORDS) invalid();

  const { cards, topics, attempts, passages, conversations, levels, tombstones } = value as unknown as SyncSnapshot;
  if (!cards.every((item) => hasKeys(item, CARD_KEYS) && isCard(item) && validId(item.id) && date(item.createdAt) &&
    date(item.updatedAt) && dueDate(item.dueAt) && item.intervalDays >= 0 && item.easeFactor > 0 &&
    Number.isSafeInteger(item.reps) && item.reps >= 0 && Number.isSafeInteger(item.lapses) && item.lapses >= 0 &&
    (item.sourceTopicId === null || validId(item.sourceTopicId)))) invalid();
  if (!topics.every((item) => hasKeys(item, TOPIC_KEYS) && isTopic(item) && validId(item.id) && date(item.createdAt) && date(item.updatedAt))) invalid();
  if (!attempts.every((item) => hasKeys(item, ATTEMPT_KEYS) && isAttempt(item) && validId(item.id) && validId(item.topicId) && date(item.createdAt) && date(item.updatedAt))) invalid();
  if (!passages.every((item) => hasKeys(item, PASSAGE_KEYS) && isReadingPassage(item) && validId(item.id) && date(item.createdAt) && date(item.updatedAt) &&
    item.sentences.length <= MAX_NESTED_ITEMS && item.reviewWords.length <= MAX_NESTED_ITEMS && item.sentences.every((sentence) => hasKeys(sentence, SENTENCE_KEYS)))) invalid();
  if (!conversations.every((item) => hasKeys(item, CONVERSATION_KEYS) && isConversationSession(item) && validId(item.id) && date(item.createdAt) && date(item.updatedAt) &&
    (item.endedAt === "" || date(item.endedAt)) && item.turns.length <= MAX_NESTED_ITEMS &&
    item.turns.every((turn) => hasKeys(turn, TURN_KEYS) && validId(turn.id)))) invalid();
  if (!levels.every((item) => hasKeys(item, LEVEL_KEYS) && isLevelRecord(item) && validId(item.language) && date(item.updatedAt) &&
    item.score >= 0 && item.score <= 1 && Number.isSafeInteger(item.samples) && item.samples >= 0)) invalid();
  if (!tombstones.every((item) => hasKeys(item, TOMBSTONE_KEYS) && STORE_NAMES.includes(item.store) && validId(item.id) && date(item.deletedAt))) invalid();

  unique(cards, (item) => item.id);
  unique(topics, (item) => item.id);
  unique(attempts, (item) => item.id);
  unique(passages, (item) => item.id);
  unique(conversations, (item) => item.id);
  unique(levels, (item) => item.language);
  unique(tombstones, (item) => `${item.store}:${item.id}`);
  for (const item of conversations) unique(item.turns, (turn) => turn.id);
  return project(value as unknown as SyncSnapshot);
}

function mergeStates(local: VaultState, remote: VaultState): VaultState {
  const combined = unionTombstones(local.tombstones, remote.tombstones);
  const deleted = new Map(combined.map((item) => [`${item.store}:${item.id}`, item.deletedAt]));
  return project({
    v: 1,
    app: "tc-lingo",
    cards: mergeStore(local.cards, remote.cards, (item) => item.id, "cards", deleted).merged,
    topics: mergeStore(local.topics, remote.topics, (item) => item.id, "topics", deleted).merged,
    attempts: mergeStore(local.attempts, remote.attempts, (item) => item.id, "attempts", deleted).merged,
    passages: mergeStore(local.passages, remote.passages, (item) => item.id, "passages", deleted).merged,
    conversations: mergeStore(local.conversations, remote.conversations, (item) => item.id, "conversations", deleted).merged,
    levels: mergeStore(local.levels, remote.levels, (item) => item.language, "levels", deleted).merged,
    tombstones: combined,
  });
}

function keepLocalFields<T>(current: T[], next: T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map(current.map((item) => [keyOf(item), item]));
  return next.map((item) => ({ ...byKey.get(keyOf(item)), ...item }));
}

function withLocalFields(next: VaultState, current: SyncSnapshot): SyncSnapshot {
  const oldPassages = new Map(current.passages.map((item) => [item.id, item]));
  const oldConversations = new Map(current.conversations.map((item) => [item.id, item]));
  return {
    ...next,
    cards: keepLocalFields(current.cards, next.cards, (item) => item.id),
    topics: keepLocalFields(current.topics, next.topics, (item) => item.id),
    attempts: keepLocalFields(current.attempts, next.attempts, (item) => item.id),
    passages: keepLocalFields(current.passages, next.passages, (item) => item.id).map((item) => ({
      ...item,
      sentences: item.sentences.map((sentence, index) => {
        const old = oldPassages.get(item.id)?.sentences[index];
        return { ...(old?.text === sentence.text ? old : undefined), ...sentence };
      }),
    })),
    conversations: keepLocalFields(current.conversations, next.conversations, (item) => item.id).map((item) => ({
      ...item,
      turns: keepLocalFields(oldConversations.get(item.id)?.turns ?? [], item.turns, (turn) => turn.id),
    })),
    levels: keepLocalFields(current.levels, next.levels, (item) => item.language),
    tombstones: keepLocalFields(current.tombstones, next.tombstones, (item) => `${item.store}:${item.id}`),
  };
}

const EMPTY: VaultState = { v: 1, app: "tc-lingo", cards: [], topics: [], attempts: [], passages: [], conversations: [], levels: [], tombstones: [] };

export function createVaultAdapter(): VaultAdapter<VaultState> {
  let captured: VaultState | undefined;
  return {
    app: "tc-lingo",
    schema: "tc-lingo/vault/1",
    snapshot() {
      // Persist migration revisions before using local records in a checkpoint.
      legacyBaseline(true);
      const state = mergeStates(parseState(project(buildSyncSnapshot())), EMPTY);
      state.tombstones = pruneTombstones(state.tombstones);
      captured = structuredClone(state);
      return state;
    },
    parse: (value) => parseState(value),
    merge(local, remote) {
      // Clock limits belong to the remote-data boundary, never to merging.
      const parsedLocal = parseState(local, Infinity);
      const merged = mergeStates(parsedLocal, parseState(remote, Infinity));
      if (JSON.stringify(local) === JSON.stringify(remote) && JSON.stringify(parsedLocal) === JSON.stringify(merged)) return local;
      return merged;
    },
    apply(next) {
      const merged = mergeStates(parseState(next), EMPTY);
      legacyBaseline(true);
      const baseline = captured ?? project(buildSyncSnapshot());
      const written = new Map<SyncStoreName, Map<string, string>>();
      const protectedKeys = new Set<string>();
      const protectedDeletes = new Set<string>();
      const keyOf = (store: SyncStoreName, item: { id?: string; language?: string }) => store === "levels" ? item.language! : item.id!;
      const guarded = () => {
        const current = buildSyncSnapshot();
        const local = project(current);
        const result = structuredClone(merged);
        for (const store of STORE_NAMES) {
          const before = new Map(baseline[store].map((item) => [keyOf(store, item), JSON.stringify(item)]));
          const records = new Map(result[store].map((item) => [keyOf(store, item), item]));
          for (const item of local[store]) {
            const id = keyOf(store, item);
            const json = JSON.stringify(item);
            if (before.get(id) !== json && written.get(store)?.get(id) !== json) {
              protectedKeys.add(`${store}:${id}`);
              records.set(id, item);
            }
          }
          for (const tombstone of local.tombstones.filter((item) => item.store === store)) {
            if (!local[store].some((item) => keyOf(store, item) === tombstone.id) &&
              !baseline.tombstones.some((item) => item.store === store && item.id === tombstone.id && item.deletedAt === tombstone.deletedAt)) {
              protectedDeletes.add(`${store}:${tombstone.id}`);
              records.delete(tombstone.id);
            }
          }
          // Each array retains its store's record type.
          Object.assign(result, { [store]: [...records.values()] });
        }
        result.tombstones = unionTombstones(local.tombstones, result.tombstones.filter((item) => !protectedKeys.has(`${item.store}:${item.id}`)));
        for (const store of STORE_NAMES) {
          const deleted = new Map(result.tombstones.filter((item) => item.store === store).map((item) => [item.id, item.deletedAt]));
          Object.assign(result, { [store]: result[store].filter((item) => {
            const id = keyOf(store, item);
            return !protectedDeletes.has(`${store}:${id}`) &&
              (!deleted.has(id) || item.updatedAt > deleted.get(id)!);
          }) });
        }
        return withLocalFields(project(result), current);
      };
      // Each refresh reads revisions and writes in the same synchronous block.
      replaceSyncSnapshot(guarded(), { source: "vault", throwOnError: true }, (store) => {
        const state = guarded();
        if (store !== "tombstones") written.set(store, new Map(project(state)[store].map((item) => [keyOf(store, item), JSON.stringify(item)])));
        return state[store];
      });
    },
    subscribe(onChange) {
      return subscribeStorageChanges((change) => {
        if (change.source !== "vault" && STORAGE_NAMES.has(change.name)) onChange();
      });
    },
  };
}
