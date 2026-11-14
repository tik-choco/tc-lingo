import { expect, it } from 'vitest';
import { storage } from './setup';
import { createVaultAdapter, type VaultState } from '../../../src/lib/vault/adapter';
import { addCard, updateCard, deleteCard, loadCards } from '../../../src/lib/cards';
import { addTopic, loadTopics } from '../../../src/lib/topics';

it('retains a newer edit made after the merge input was captured', () => {
  const adapter = createVaultAdapter();
  const card = addCard({ front: 'train', meaning: 'before' });
  const next = adapter.snapshot() as VaultState;
  updateCard(card.id, { meaning: 'latest local edit' });
  adapter.apply(next);
  expect(loadCards()[0].meaning).toBe('latest local edit');
});

it('retains a record added after the merge input was captured', () => {
  const adapter = createVaultAdapter();
  const next = adapter.snapshot() as VaultState;
  const card = addCard({ front: 'train', meaning: 'new local record' });
  adapter.apply(next);
  expect(loadCards().map(c => c.id)).toContain(card.id);
});

it('does not resurrect a deletion made after the merge input was captured', () => {
  const adapter = createVaultAdapter();
  const card = addCard({ front: 'train', meaning: 'before' });
  const next = adapter.snapshot() as VaultState;
  deleteCard(card.id);
  adapter.apply(next);
  expect(loadCards()).toEqual([]);
});

it('retains an edit to a later store made while apply is persisting an earlier store', () => {
  const adapter = createVaultAdapter();
  adapter.snapshot();
  // Obtain an incoming card and topic without leaving them in the destination.
  addCard({ front: 'remote', meaning: 'incoming' });
  addTopic({ title: 'remote topic', prompt: 'incoming', custom: true });
  const incoming = adapter.snapshot() as VaultState;
  storage.clear();
  let addedId = '';
  const onRefresh = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.name === 'cards-v1' && detail.source === 'vault' && !addedId) {
      addedId = addTopic({ title: 'concurrent local topic', prompt: 'keep', custom: true }).id;
    }
  };
  window.addEventListener('tc-lingo-data-changed', onRefresh);
  adapter.apply(incoming);
  window.removeEventListener('tc-lingo-data-changed', onRefresh);
  expect(loadTopics().map(t => t.id)).toContain(addedId);
});
