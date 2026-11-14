import { expect, it, vi } from 'vitest';
import { storage } from './setup';
import { createVaultAdapter, type VaultState } from '../../../src/lib/vault/adapter';
import { addCard, deleteCard, loadCards } from '../../../src/lib/cards';
import { addTopic, deleteTopic, loadTopics } from '../../../src/lib/topics';
import { addPassage, deletePassage, loadPassages } from '../../../src/lib/reading';
import { addConversation, deleteConversation, loadConversations } from '../../../src/lib/conversation';

const cases = [
  { store: 'cards', add: () => addCard({ front: 'x'.repeat(1000), meaning: 'vehicle' }).id, remove: deleteCard, load: loadCards },
  { store: 'topics', add: () => addTopic({ title: 'Travel', prompt: 'x'.repeat(1000), custom: true }).id, remove: deleteTopic, load: loadTopics },
  { store: 'passages', add: () => addPassage({ language: 'English', title: 'x'.repeat(1000), sentences: [] }).id, remove: deletePassage, load: loadPassages },
  { store: 'conversations', add: () => addConversation({ language: 'English', title: 'x'.repeat(1000), scenario: '' }).id, remove: deleteConversation, load: loadConversations },
] as const;

for (const item of cases) {
  it(item.store + ': deletion at quota remains deleted after a remote merge', () => {
    const adapter = createVaultAdapter();
    const id = item.add();
    const remote = adapter.snapshot() as VaultState;
    // Storage is exactly full. Replacing a large array with [] is possible,
    // but adding a new tombstone key before freeing that space is not.
    const quota = [...storage.values.values()].reduce((n, value) => n + value.length, 0);
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      const used = [...storage.values].reduce((n, [k, v]) => n + (k === key ? 0 : v.length), 0);
      if (used + value.length > quota) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      setItem(key, value);
    });
    item.remove(id);
    expect(item.load()).toEqual([]);
    const merged = adapter.merge(adapter.snapshot() as VaultState, remote);
    expect(merged[item.store]).toEqual([]);
  });
}

for (const store of ['passages', 'conversations'] as const) {
  it(store + ': a failed addition does not tombstone a record that was never evicted', () => {
    const adapter = createVaultAdapter();
    const add = (title: string) => store === 'passages'
      ? addPassage({ language: 'English', title, sentences: [] })
      : addConversation({ language: 'English', title, scenario: '' });
    const limit = store === 'passages' ? 30 : 20;
    for (let i = 0; i < limit; i++) { add('existing ' + i); vi.advanceTimersByTime(1); }
    const before = adapter.snapshot() as VaultState;
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'tc-lingo:' + store + '-v1') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      setItem(key, value);
    });
    add('new passage that fails to persist');
    expect(JSON.parse(storage.getItem('tc-lingo:' + store + '-v1')!)).toHaveLength(limit);
    const after = adapter.snapshot() as VaultState;
    expect(after[store].map(record => record.id)).toEqual(before[store].map(record => record.id));
  });
}
