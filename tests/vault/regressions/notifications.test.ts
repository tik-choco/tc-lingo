import { expect, it, vi } from 'vitest';
import './setup';
import { createVaultAdapter, type VaultState } from '../../../src/lib/vault/adapter';
import { addCard, updateCard, gradeCard, deleteCard, mergeCards } from '../../../src/lib/cards';
import { addTopic, addAttempt, updateAttempt, deleteTopic } from '../../../src/lib/topics';
import { addPassage, deletePassage } from '../../../src/lib/reading';
import { addConversation, updateConversation, deleteConversation, newTurn } from '../../../src/lib/conversation';
import { recordOutputSample, setLevelOverride } from '../../../src/lib/level';
import { mergeSyncSnapshot } from '../../../src/lib/sync/snapshot';

const operations = {
  addCard: () => addCard({ front: 'train', meaning: 'vehicle' }),
  updateCard: () => { const c = addCard({ front: 'train', meaning: 'old' }); return () => updateCard(c.id, { meaning: 'new' }); },
  gradeCard: () => { const c = addCard({ front: 'train', meaning: 'vehicle' }); return () => gradeCard(c.id, 'good'); },
  deleteCard: () => { const c = addCard({ front: 'train', meaning: 'vehicle' }); return () => deleteCard(c.id); },
  mergeCards: () => { const a = addCard({ front: 'train', meaning: 'a' }); const b = addCard({ front: 'rail', meaning: 'b' }); return () => mergeCards([a.id,b.id], { front: 'train', reading: '', meaning: 'vehicle', exampleSentence: '', context: '', cloze: '' }); },
  addTopic: () => addTopic({ title: 'Travel', prompt: 'Describe a trip', custom: true }),
  deleteTopic: () => { const t = addTopic({ title: 'Travel', prompt: 'Describe a trip', custom: true }); addAttempt({ topicId: t.id, round: 1, original: 'I went' }); return () => deleteTopic(t.id); },
  addAttempt: () => { const t = addTopic({ title: 'Travel', prompt: 'Describe a trip', custom: true }); return () => addAttempt({ topicId: t.id, round: 1, original: 'I went' }); },
  updateAttempt: () => { const t = addTopic({ title: 'Travel', prompt: 'Describe a trip', custom: true }); const a = addAttempt({ topicId: t.id, round: 1, original: 'I went' }); return () => updateAttempt(a.id, { retryAnswer: 'By train' }); },
  addPassage: () => addPassage({ language: 'English', title: 'Travel', sentences: [] }),
  deletePassage: () => { const p = addPassage({ language: 'English', title: 'Travel', sentences: [] }); return () => deletePassage(p.id); },
  addConversation: () => addConversation({ language: 'English', title: 'Travel', scenario: 'Tickets' }),
  updateConversation: () => { const c = addConversation({ language: 'English', title: 'Travel', scenario: 'Tickets' }); return () => updateConversation(c.id, { turns: [newTurn({ role: 'learner', text: 'Hello' })], endedAt: new Date().toISOString() }); },
  deleteConversation: () => { const c = addConversation({ language: 'English', title: 'Travel', scenario: 'Tickets' }); return () => deleteConversation(c.id); },
  recordOutputSample: () => recordOutputSample('English', 'I went', ''),
  setLevelOverride: () => setLevelOverride('English', 'B1'),
  mergeSyncSnapshot: () => { const adapter = createVaultAdapter(); adapter.snapshot(); addCard({ front: 'remote', meaning: 'import' }); const remote = adapter.snapshot() as VaultState; localStorage.clear(); return () => mergeSyncSnapshot(remote); },
};

for (const [name, prepare] of Object.entries(operations)) {
  it(name + ' notifies about its actual persisted mutation', () => {
    const changed = vi.fn();
    const stop = createVaultAdapter().subscribe(changed);
    const action = prepare();
    if (typeof action === 'function') { changed.mockClear(); action(); }
    expect(changed).toHaveBeenCalled();
    stop();
  });
}

it('applying changed remote state refreshes the UI without marking the vault dirty', () => {
  const adapter = createVaultAdapter();
  addCard({ front: 'remote', meaning: 'restore' });
  const state = adapter.snapshot() as VaultState;
  localStorage.clear();
  const changed = vi.fn();
  const refresh = vi.fn();
  const stop = adapter.subscribe(changed);
  window.addEventListener('tc-lingo-data-changed', refresh);
  adapter.apply(state);
  expect(refresh).toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  window.removeEventListener('tc-lingo-data-changed', refresh);
  stop();
});
