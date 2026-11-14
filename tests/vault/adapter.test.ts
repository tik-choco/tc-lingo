import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCard, deleteCard, gradeCard, loadCards, updateCard } from "../../src/lib/cards";
import { addConversation, deleteConversation, loadConversations, newTurn, updateConversation } from "../../src/lib/conversation";
import { loadLevels, recordOutputSample, setLevelOverride } from "../../src/lib/level";
import { addPassage, loadPassages } from "../../src/lib/reading";
import { saveJson, subscribeStorage } from "../../src/lib/storage";
import { mergeSyncSnapshot } from "../../src/lib/sync/snapshot";
import { loadTombstones, recordTombstones } from "../../src/lib/sync/tombstones";
import { addAttempt, addTopic, deleteTopic, loadAttempts, loadTopics, updateAttempt } from "../../src/lib/topics";
import { createVaultAdapter, type VaultState } from "../../src/lib/vault/adapter";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(String(key), String(value)); }
}

const now = "2026-11-14T12:00:00.000Z";
let storage: MemoryStorage;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function snapshot(): VaultState {
  return createVaultAdapter().snapshot() as VaultState;
}

function seed(): VaultState {
  const topic = addTopic({ title: "Travel", prompt: "Describe a trip", custom: true, language: "English" });
  addAttempt({ topicId: topic.id, round: 1, original: "I went by train" });
  addCard({ front: "train", meaning: "a railway vehicle", language: "English" });
  addPassage({ language: "English", title: "A journey", sentences: [{ text: "We left early.", translation: "早く出発した。", reading: "" }] });
  addConversation({ language: "English", title: "Station", scenario: "Buy a ticket", turns: [newTurn({ role: "assistant", text: "Where to?" })] });
  recordOutputSample("English", "I went by train", "");
  return snapshot();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("vault adapter", () => {
  it("round trips every shared store through snapshot, parse and apply and refreshes existing listeners", () => {
    const original = seed();
    const adapter = createVaultAdapter();
    const parsed = adapter.parse(JSON.parse(JSON.stringify(original)));
    storage.clear();
    storage.setItem("tc-lingo:settings-v1", JSON.stringify({ apiKey: "keep-local" }));
    const uiRefresh = vi.fn();
    const vaultChange = vi.fn();
    const otherVaultChange = vi.fn();
    const stopUi = subscribeStorage(uiRefresh);
    const stopVault = adapter.subscribe(vaultChange);
    const stopOther = createVaultAdapter().subscribe(otherVaultChange);

    adapter.apply(parsed);

    expect(snapshot()).toEqual(original);
    expect(loadCards()).toEqual(original.cards);
    expect(loadTopics()).toEqual(original.topics);
    expect(loadAttempts()).toEqual(original.attempts);
    expect(loadPassages()).toEqual(original.passages);
    expect(loadConversations()).toEqual(original.conversations);
    expect(loadLevels()).toEqual(original.levels);
    expect(JSON.parse(storage.getItem("tc-lingo:settings-v1")!)).toEqual({ apiKey: "keep-local" });
    expect(uiRefresh).toHaveBeenCalled();
    expect(vaultChange).not.toHaveBeenCalled();
    expect(otherVaultChange).not.toHaveBeenCalled();
    uiRefresh.mockClear();
    adapter.apply(parsed);
    expect(uiRefresh).not.toHaveBeenCalled();
    stopUi(); stopVault(); stopOther();
  });

  it("accepts legacy local records whose optional fields and updatedAt predate sync", () => {
    seed();
    const raw = JSON.parse(storage.getItem("tc-lingo:cards-v1")!);
    delete raw[0].updatedAt;
    delete raw[0].language;
    delete raw[0].exampleSentenceTranslation;
    storage.setItem("tc-lingo:cards-v1", JSON.stringify(raw));
    const card = snapshot().cards[0];
    expect(card.updatedAt).toBe(card.createdAt);
    expect(card.language).toBe("");
    expect(card.exampleSentenceTranslation).toBe("");
    expect(createVaultAdapter().parse(snapshot())).toEqual(snapshot());
  });

  it("includes no settings, secrets, cache entries, or foreign properties inside records", () => {
    seed();
    storage.setItem("tc-lingo:settings-v1", JSON.stringify({ apiKey: "secret-setting", tts: "secret-voice" }));
    storage.setItem("tc-vault:settings-v1", JSON.stringify({ code: "secret-vault-code" }));
    storage.setItem("tc-lingo-card-embeddings-v1", "secret-cache");
    storage.setItem("tc-lingo-mistllm-node-id-v1", "secret-node-id");
    const cards = JSON.parse(storage.getItem("tc-lingo:cards-v1")!);
    cards[0].apiKey = "secret-card-property";
    storage.setItem("tc-lingo:cards-v1", JSON.stringify(cards));
    const conversations = JSON.parse(storage.getItem("tc-lingo:conversations-v1")!);
    conversations[0].turns[0].privateKey = "secret-turn-property";
    storage.setItem("tc-lingo:conversations-v1", JSON.stringify(conversations));
    const passages = JSON.parse(storage.getItem("tc-lingo:passages-v1")!);
    passages[0].sentences[0].token = "secret-sentence-property";
    storage.setItem("tc-lingo:passages-v1", JSON.stringify(passages));
    const json = JSON.stringify(snapshot());
    expect(json).not.toMatch(/secret-|apiKey|privateKey|"token"|settings|embeddings/);
    const updated = snapshot();
    updated.cards[0].meaning = "updated meaning";
    updated.cards[0].updatedAt = "2026-11-14T12:00:01.000Z";
    updated.conversations[0].turns[0].text = "A different question";
    updated.conversations[0].updatedAt = "2026-11-14T12:00:01.000Z";
    createVaultAdapter().apply(updated);
    expect(JSON.parse(storage.getItem("tc-lingo:cards-v1")!)[0].apiKey).toBe("secret-card-property");
    expect(JSON.parse(storage.getItem("tc-lingo:conversations-v1")!)[0].turns[0].privateKey).toBe("secret-turn-property");
    expect(JSON.parse(storage.getItem("tc-lingo:passages-v1")!)[0].sentences[0].token).toBe("secret-sentence-property");
    expect(JSON.stringify(snapshot())).not.toMatch(/secret-|apiKey|privateKey|"token"/);
  });

  it("does not rewrite unchanged stores solely because object key order differs", () => {
    seed();
    const adapter = createVaultAdapter();
    const uiRefresh = vi.fn();
    const stop = subscribeStorage(uiRefresh);
    adapter.apply(snapshot());
    expect(uiRefresh).not.toHaveBeenCalled();
    stop();
  });

  it("merges disjoint edits in either order and is idempotent", () => {
    const base = seed();
    const local = clone(base);
    const remote = clone(base);
    local.cards[0].meaning = "local change";
    local.cards[0].updatedAt = "2026-11-14T12:00:01.000Z";
    remote.topics[0].title = "remote change";
    remote.topics[0].updatedAt = "2026-11-14T12:00:02.000Z";
    const adapter = createVaultAdapter();
    const merged = adapter.merge(local, remote);
    expect(merged).toEqual(adapter.merge(remote, local));
    expect(merged.cards[0].meaning).toBe("local change");
    expect(merged.topics[0].title).toBe("remote change");
    expect(adapter.merge(merged, merged)).toEqual(merged);
    expect(adapter.merge(merged, remote)).toEqual(merged);
  });

  it("is idempotent even when a caller supplies records in a different order", () => {
    seed();
    addCard({ front: "station", meaning: "a stopping place" });
    const state = snapshot();
    state.cards.reverse();
    expect(createVaultAdapter().merge(state, state)).toEqual(state);
  });

  it.each([
    ["cards", "meaning", "earlier", "later"],
    ["topics", "title", "earlier", "later"],
    ["attempts", "original", "earlier", "later"],
    ["passages", "title", "earlier", "later"],
    ["conversations", "scenario", "earlier", "later"],
    ["levels", "score", 0.2, 0.8],
  ] as const)("uses the newer %s record irrespective of side", (store, field, earlier, later) => {
    const old = seed();
    const newer = clone(old);
    const oldRecord = old[store][0] as unknown as Record<string, unknown>;
    const newRecord = newer[store][0] as unknown as Record<string, unknown>;
    oldRecord[field] = earlier;
    newRecord[field] = later;
    oldRecord.updatedAt = "2026-11-14T11:00:00.000Z";
    newRecord.updatedAt = "2026-11-14T11:00:01.000Z";
    const adapter = createVaultAdapter();
    expect(adapter.merge(old, newer)[store][0]).toEqual(newRecord);
    expect(adapter.merge(newer, old)[store][0]).toEqual(newRecord);
  });

  it("breaks equal-timestamp conflicts consistently even when object keys are reordered", () => {
    const a = seed();
    const b = clone(a);
    a.cards[0].meaning = "alpha";
    b.cards[0].meaning = "zeta";
    b.cards[0] = Object.fromEntries(Object.entries(b.cards[0]).reverse()) as unknown as typeof b.cards[0];
    const adapter = createVaultAdapter();
    expect(adapter.merge(a, b)).toEqual(adapter.merge(b, a));
    expect(adapter.merge(a, b).cards[0].meaning).toBe("zeta");
  });

  it("keeps deletions and permits a genuinely newer record to survive", () => {
    const before = seed();
    const id = before.cards[0].id;
    deleteCard(id);
    const after = snapshot();
    const adapter = createVaultAdapter();
    expect(after.tombstones.find((t) => t.id === id)!.deletedAt > before.cards[0].updatedAt).toBe(true);
    const deleted = adapter.merge(before, after);
    expect(deleted.cards).toEqual([]);
    expect(adapter.merge(deleted, before).cards).toEqual([]);
    expect(adapter.merge(after, before).cards).toEqual([]);
    const restored = clone(before);
    restored.cards[0].updatedAt = "2026-11-14T12:00:02.000Z";
    expect(adapter.merge(restored, after).cards).toEqual(restored.cards);
  });

  it.each(["cards", "topics", "attempts", "passages", "conversations", "levels"] as const)(
    "resolves %s tombstones by the record's own key and revision", (store) => {
      const original = seed();
      const deleted = clone(original);
      const item = original[store][0] as unknown as { id?: string; language?: string; updatedAt: string };
      const id = store === "levels" ? item.language! : item.id!;
      deleted[store] = [];
      deleted.tombstones = [{ store, id, deletedAt: "2026-11-14T12:00:01.000Z" }];
      const adapter = createVaultAdapter();
      expect(adapter.merge(original, deleted)[store]).toEqual([]);
      expect(adapter.merge(deleted, original)[store]).toEqual([]);
      item.updatedAt = "2026-11-14T12:00:02.000Z";
      expect(adapter.merge(original, deleted)[store]).toHaveLength(1);
    },
  );

  it("preserves a concurrent attempt even if its topic was deleted elsewhere", () => {
    const before = seed();
    deleteTopic(before.topics[0].id);
    const deleted = snapshot();
    const remote = clone(before);
    remote.attempts.push({ ...clone(remote.attempts[0]), id: "new-attempt", updatedAt: "2026-11-14T12:00:02.000Z" });
    const merged = createVaultAdapter().merge(deleted, remote);
    expect(merged.topics).toEqual([]);
    expect(merged.attempts.map((a) => a.id)).toEqual(["new-attempt"]);
    expect(mergeSyncSnapshot(remote)).not.toBeNull();
    expect(loadAttempts().map((a) => a.id)).toEqual(["new-attempt"]);
  });

  it("retains expired tombstones during merge and prunes only at snapshot", () => {
    const state = seed();
    state.cards[0].updatedAt = "2026-01-01T00:00:00.000Z";
    const deletion = clone(state);
    deletion.cards = [];
    deletion.tombstones = [{ store: "cards", id: state.cards[0].id, deletedAt: "2026-02-01T00:00:00.000Z" }];
    const merged = createVaultAdapter().merge(state, deletion);
    expect(merged.cards).toEqual([]);
    expect(merged.tombstones).toEqual(deletion.tombstones);
  });

  it("retains more than 2,000 recent tombstones and prunes old ones", () => {
    const recent = Array.from({ length: 2100 }, (_, i) => ({ store: "cards", id: `card-${i}`, deletedAt: now }));
    saveJson("sync-tombstones-v1", [...recent, { store: "cards", id: "old", deletedAt: "2026-01-01T00:00:00.000Z" }]);
    recordTombstones("cards", [{ id: "new" }]);
    expect(loadTombstones()).toHaveLength(2102);
    expect(snapshot().tombstones.some((item) => item.id === "old")).toBe(false);
  });

  it("records automatic passage and conversation evictions as deletions", () => {
    const firstPassage = addPassage({ language: "English", title: "First", sentences: [] });
    const firstConversation = addConversation({ language: "English", title: "First", scenario: "" });
    const old = snapshot();
    for (let i = 0; i < 30; i++) addPassage({ language: "English", title: `${i}`, sentences: [] });
    for (let i = 0; i < 20; i++) addConversation({ language: "English", title: `${i}`, scenario: "" });
    const next = snapshot();
    expect(next.tombstones.some((t) => t.store === "passages" && t.id === firstPassage.id)).toBe(true);
    expect(next.tombstones.some((t) => t.store === "conversations" && t.id === firstConversation.id)).toBe(true);
    const merged = createVaultAdapter().merge(next, old);
    expect(merged.passages.some((p) => p.id === firstPassage.id)).toBe(false);
    expect(merged.conversations.some((c) => c.id === firstConversation.id)).toBe(false);
  });

  it("advances rapid edits and deletions beyond already-seen revisions", () => {
    const state = seed();
    const future = "2026-11-15T12:00:00.000Z";
    state.cards[0].updatedAt = future;
    state.attempts[0].updatedAt = future;
    state.conversations[0].updatedAt = future;
    state.levels[0].updatedAt = future;
    createVaultAdapter().apply(state);
    updateCard(state.cards[0].id, { meaning: "changed" });
    updateAttempt(state.attempts[0].id, { original: "changed" });
    updateConversation(state.conversations[0].id, { title: "changed" });
    setLevelOverride("English", "B1");
    const edited = snapshot();
    for (const item of [edited.cards[0], edited.attempts[0], edited.conversations[0], edited.levels[0]]) expect(item.updatedAt > future).toBe(true);
    gradeCard(state.cards[0].id, "good");
    expect(snapshot().cards[0].updatedAt > edited.cards[0].updatedAt).toBe(true);
    deleteCard(state.cards[0].id);
    deleteConversation(state.conversations[0].id);
    expect(snapshot().tombstones.find((t) => t.id === state.cards[0].id)!.deletedAt > edited.cards[0].updatedAt).toBe(true);
    expect(snapshot().tombstones.find((t) => t.id === state.conversations[0].id)!.deletedAt > edited.conversations[0].updatedAt).toBe(true);
  });

  it("notifies only for shared local edits and relevant cross-tab changes", () => {
    const adapter = createVaultAdapter();
    const changed = vi.fn();
    const stop = adapter.subscribe(changed);
    saveJson("settings-v1", { theme: "dark" });
    saveJson("card-inbox-state-v1", { cursor: 1 });
    expect(changed).not.toHaveBeenCalled();
    addCard({ front: "hello", meaning: "greeting" });
    expect(changed).toHaveBeenCalledTimes(1);
    const external = new Event("storage");
    Object.defineProperty(external, "key", { value: "tc-lingo:topics-v1" });
    window.dispatchEvent(external);
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    addCard({ front: "bye", meaning: "farewell" });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("does not expose parts because these stores have no blob attachments", () => {
    expect(createVaultAdapter().parts).toBeUndefined();
  });

  it("propagates storage failures during restore", () => {
    const state = seed();
    storage.clear();
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => createVaultAdapter().apply(state)).toThrow("quota");
  });

  it("can finish a restore after a later store write fails", () => {
    const state = seed();
    storage.clear();
    const setItem = storage.setItem.bind(storage);
    let fail = true;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === "tc-lingo:topics-v1" && fail) {
        fail = false;
        throw new Error("quota");
      }
      setItem(key, value);
    });
    const adapter = createVaultAdapter();
    const changed = vi.fn();
    const stop = adapter.subscribe(changed);
    expect(() => adapter.apply(state)).toThrow("quota");
    expect(storage.getItem("tc-lingo:cards-v1")).toBeNull();
    expect(snapshot().cards).toEqual([]);
    adapter.apply(state);
    expect(snapshot()).toEqual(state);
    expect(changed).not.toHaveBeenCalled();
    stop();
  });

  it("restores previous stored values when a later write fails", () => {
    const before = seed();
    const next = clone(before);
    next.cards[0].meaning = "a much longer restored card definition";
    next.topics[0].title = "restored topic";
    const rawCard = storage.getItem("tc-lingo:cards-v1");
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === "tc-lingo:topics-v1") throw new Error("quota");
      setItem(key, value);
    });
    expect(() => createVaultAdapter().apply(next)).toThrow("quota");
    expect(storage.getItem("tc-lingo:cards-v1")).toBe(rawCard);
    expect(snapshot()).toEqual(before);
  });

  it("reports when storage also prevents a rollback", () => {
    const before = seed();
    const next = clone(before);
    next.cards[0].meaning = "a much longer restored card definition";
    next.topics[0].title = "restored topic";
    const setItem = storage.setItem.bind(storage);
    let cardWrites = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === "tc-lingo:topics-v1" || (key === "tc-lingo:cards-v1" && ++cardWrites > 1)) throw new Error("quota");
      setItem(key, value);
    });
    expect(() => createVaultAdapter().apply(next)).toThrow("Vault restore rollback failed");
  });

  it("does not roll back a store that was edited concurrently", () => {
    const state = seed();
    storage.clear();
    const setItem = storage.setItem.bind(storage);
    let fail = true;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === "tc-lingo:topics-v1" && fail) {
        fail = false;
        throw new Error("quota");
      }
      setItem(key, value);
    });
    const onWrite = (event: Event) => {
      const detail = (event as CustomEvent<{ name: string; source: string }>).detail;
      if (detail.name === "cards-v1" && detail.source === "vault") {
        const cards = JSON.parse(storage.getItem("tc-lingo:cards-v1")!);
        cards[0].meaning = "concurrent edit";
        setItem("tc-lingo:cards-v1", JSON.stringify(cards));
      }
    };
    window.addEventListener("tc-lingo-data-changed", onWrite);
    expect(() => createVaultAdapter().apply(state)).toThrow("quota");
    expect(loadCards()[0].meaning).toBe("concurrent edit");
    window.removeEventListener("tc-lingo-data-changed", onWrite);
  });

  it("rejects malformed, ambiguous, oversized, and non-JSON checkpoints", () => {
    const good = seed();
    const invalid: unknown[] = [null, [], { ...good, app: "other" }, { ...good, v: 2 }, { ...good, settings: { token: "x" } }];
    const missingField = clone(good) as unknown as Record<string, unknown>;
    delete missingField.cards;
    invalid.push(missingField);
    const badCard = clone(good);
    badCard.cards[0].updatedAt = "yesterday";
    invalid.push(badCard);
    const badNested = clone(good) as unknown as { passages: { sentences: Record<string, unknown>[] }[] };
    badNested.passages[0].sentences[0].extra = "x";
    invalid.push(badNested);
    const duplicate = clone(good);
    duplicate.cards.push(clone(duplicate.cards[0]));
    invalid.push(duplicate);
    const badNumber = clone(good);
    badNumber.levels[0].score = NaN;
    invalid.push(badNumber);
    const huge = clone(good);
    huge.cards[0].front = "x".repeat(2 * 1024 * 1024 + 1);
    invalid.push(huge);
    const badArray = clone(good) as unknown as Record<string, unknown>;
    badArray.cards = new Array(100_001).fill(null);
    invalid.push(badArray);
    const adapter = createVaultAdapter();
    for (const value of invalid) expect(() => adapter.parse(value)).toThrow("Invalid vault checkpoint");
  });
});
