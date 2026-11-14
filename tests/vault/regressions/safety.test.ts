import { expect, it, vi } from 'vitest';
import { storage } from './setup';
import { addCard, deleteCard, loadCards, updateCard } from '../../../src/lib/cards';
import { addTopic, addAttempt, deleteTopic, loadTopics, loadAttempts } from '../../../src/lib/topics';
import { addPassage, deletePassage } from '../../../src/lib/reading';
import { addConversation, deleteConversation } from '../../../src/lib/conversation';
import { loadLevels, setLevelOverride } from '../../../src/lib/level';
import { nextUpdatedAt, saveJsonBatch } from '../../../src/lib/storage';
import { loadTombstones } from '../../../src/lib/sync/tombstones';
import { createVaultAdapter, type VaultState } from '../../../src/lib/vault/adapter';

const now = '2026-11-14T12:00:00.000Z';
const stores = ['cards', 'topics', 'attempts', 'passages', 'conversations', 'levels'] as const;

function seed() {
  const topic = addTopic({ title: 'Travel', prompt: 'Write', custom: true });
  addAttempt({ topicId: topic.id, round: 1, original: 'Hello' });
  addCard({ front: 'train', meaning: 'vehicle' });
  addPassage({ language: 'English', title: 'Travel', sentences: [] });
  addConversation({ language: 'English', title: 'Travel', scenario: '' });
  setLevelOverride('English', 'B1');
}

it('persists the legacy baseline across reloads and preserves proven later child edits', () => {
  seed();
  for (const store of stores) {
    const key = 'tc-lingo:' + store + '-v1';
    const items = JSON.parse(storage.getItem(key)!);
    delete items[0].updatedAt;
    items[0].createdAt = '2026-01-01T00:00:00.000Z';
    if (store === 'conversations') items[0].endedAt = '2026-11-15T12:00:00.000Z';
    storage.setItem(key, JSON.stringify(items));
  }
  const adapter = createVaultAdapter();
  const first = adapter.snapshot() as VaultState;
  vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
  const second = createVaultAdapter().snapshot() as VaultState;
  expect(second).toEqual(first);
  for (const store of stores) expect(first[store][0].updatedAt).toBe(store === 'conversations' ? '2026-11-15T12:00:00.000Z' : now);
  expect(loadLevels()).toHaveLength(1);
});

for (const store of stores) {
  it(store + ': skips an intervening revision even if incoming data has a later clock', () => {
    seed();
    const adapter = createVaultAdapter();
    const incoming = structuredClone(adapter.snapshot() as VaultState);
    incoming[store][0].updatedAt = '2026-11-16T12:00:00.000Z';
    const key = 'tc-lingo:' + store + '-v1';
    const items = JSON.parse(storage.getItem(key)!);
    items[0].updatedAt = '2026-11-15T12:00:00.000Z';
    storage.setItem(key, JSON.stringify(items));
    adapter.apply(incoming);
    expect(JSON.parse(storage.getItem(key)!)[0].updatedAt).toBe('2026-11-15T12:00:00.000Z');
  });
}

it('skips incoming deletions when the record changed after snapshot', () => {
  const adapter = createVaultAdapter();
  const card = addCard({ front: 'train', meaning: 'before' });
  const incoming = structuredClone(adapter.snapshot() as VaultState);
  incoming.cards = [];
  incoming.tombstones.push({ store: 'cards', id: card.id, deletedAt: '2026-11-16T12:00:00.000Z' });
  updateCard(card.id, { meaning: 'keep my edit' });
  adapter.apply(incoming);
  expect(loadCards()[0].meaning).toBe('keep my edit');
  expect((adapter.snapshot() as VaultState).cards[0].meaning).toBe('keep my edit');
});

it('keeps a concurrent deletion even against an incoming record with a later clock', () => {
  const adapter = createVaultAdapter();
  const card = addCard({ front: 'train', meaning: 'before' });
  const incoming = structuredClone(adapter.snapshot() as VaultState);
  incoming.cards[0].updatedAt = '2026-11-16T12:00:00.000Z';
  deleteCard(card.id);
  adapter.apply(incoming);
  expect(loadCards()).toEqual([]);
  expect(loadTombstones().some(item => item.id === card.id)).toBe(true);
});

it('does not drop local tombstones that were pruned from the snapshot', () => {
  const adapter = createVaultAdapter();
  storage.setItem('tc-lingo:sync-tombstones-v1', JSON.stringify([{ store: 'cards', id: 'old', deletedAt: '2026-01-01T00:00:00.000Z' }]));
  adapter.apply(adapter.snapshot() as VaultState);
  expect(loadTombstones()).toHaveLength(1);
});

for (const field of ['createdAt', 'updatedAt', 'dueAt'] as const) {
  const invalidDates = ['1969-12-31T23:59:59.999Z', '2026-11-14T12:00:00.0001Z'];
  if (field !== 'dueAt') invalidDates.push('2027-11-15T12:00:00.001Z');
  for (const invalid of invalidDates) {
    it('rejects an invalid ' + field + ': ' + invalid, () => {
      addCard({ front: 'train', meaning: 'vehicle' });
      const adapter = createVaultAdapter();
      const state = adapter.snapshot() as VaultState;
      state.cards[0][field] = invalid;
      expect(() => adapter.parse(state)).toThrow('Invalid vault checkpoint');
    });
  }
}

it('bounds tombstone and session timestamps and accepts the exact future limit', () => {
  seed();
  const adapter = createVaultAdapter();
  const state = adapter.snapshot() as VaultState;
  const limit = new Date(Date.now() + 366 * 86400000).toISOString();
  state.cards[0].updatedAt = limit;
  expect(adapter.parse(state).cards[0].updatedAt).toBe(limit);
  expect(nextUpdatedAt(limit)).toBe(new Date(Date.parse(limit) + 1).toISOString());
  state.conversations[0].endedAt = new Date(Date.parse(limit) + 1).toISOString();
  expect(() => adapter.parse(state)).toThrow();
  state.conversations[0].endedAt = '';
  state.tombstones.push({ store: 'cards', id: 'gone', deletedAt: new Date(Date.parse(limit) + 1).toISOString() });
  expect(() => adapter.parse(state)).toThrow();
});

it('merges without consulting the clock, storage, or randomness', () => {
  seed();
  const adapter = createVaultAdapter();
  const state = adapter.snapshot() as VaultState;
  vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
  vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('storage'); });
  vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
  expect(adapter.merge(state, structuredClone(state))).toEqual(state);
});

it('retries failed rollbacks after restoring the other keys, in reverse order', () => {
  const names = ['one', 'two', 'three', 'four'];
  for (const name of names) storage.setItem('tc-lingo:' + name, '"before"');
  const original = storage.setItem.bind(storage);
  const attempts: string[] = [];
  let firstRollback = true;
  vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith('four')) throw new Error('quota');
    if (value === '"before"') {
      attempts.push(key);
      if (key.endsWith('three') && firstRollback) { firstRollback = false; throw new Error('quota'); }
    }
    original(key, value);
  });
  expect(() => saveJsonBatch(names.map(name => ({ name, value: 'after' })), { throwOnError: true })).toThrow('quota');
  expect(attempts).toEqual(['tc-lingo:three', 'tc-lingo:two', 'tc-lingo:one', 'tc-lingo:three']);
  for (const name of names) expect(storage.getItem('tc-lingo:' + name)).toBe('"before"');
});

for (const store of ['cards', 'topics', 'passages', 'conversations'] as const) {
  it(store + ': rolls back removal when its tombstone cannot be stored', () => {
    seed();
    const before = new Map(storage.values);
    const state = createVaultAdapter().snapshot() as VaultState;
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'tc-lingo:sync-tombstones-v1') throw new Error('quota');
      setItem(key, value);
    });
    if (store === 'cards') deleteCard(state.cards[0].id);
    if (store === 'topics') deleteTopic(state.topics[0].id);
    if (store === 'passages') deletePassage(state.passages[0].id);
    if (store === 'conversations') deleteConversation(state.conversations[0].id);
    expect(storage.values).toEqual(before);
    expect(loadCards()).toHaveLength(1);
    expect(loadTopics()).toHaveLength(1);
    expect(loadAttempts()).toHaveLength(1);
  });
}

for (const store of ['passages', 'conversations'] as const) {
  it(store + ': restores an evicted record if its tombstone write fails', () => {
    const add = (title: string) => store === 'passages'
      ? addPassage({ language: 'English', title, sentences: [] })
      : addConversation({ language: 'English', title, scenario: '' });
    for (let i = 0; i < (store === 'passages' ? 30 : 20); i++) add(String(i));
    const before = new Map(storage.values);
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'tc-lingo:sync-tombstones-v1') throw new Error('quota');
      setItem(key, value);
    });
    add('eviction fails');
    expect(storage.values).toEqual(before);
  });
}

it('restores a topic when deleting its attempts fails before tombstones are stored', () => {
  seed();
  const before = new Map(storage.values);
  const id = loadTopics()[0].id;
  const setItem = storage.setItem.bind(storage);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
    if (key === 'tc-lingo:attempts-v1') throw new Error('quota');
    setItem(key, value);
  });
  deleteTopic(id);
  expect(storage.values).toEqual(before);
});
