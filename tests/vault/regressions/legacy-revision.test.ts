import { expect, it, vi } from 'vitest';
import { storage } from './setup';
import { addCard, loadCards } from '../../../src/lib/cards';
import { createVaultAdapter, type VaultState } from '../../../src/lib/vault/adapter';

it('preserves a legacy local revision against a known older remote revision', () => {
  const adapter = createVaultAdapter();
  const created = addCard({ front: 'train', meaning: 'old definition' });
  const remote = adapter.snapshot() as VaultState;
  remote.cards[0].createdAt = '2026-01-01T00:00:00.000Z';
  remote.cards[0].updatedAt = '2026-02-01T00:00:00.000Z';
  // A pre-sync installation edited this card in November without updatedAt.
  const legacy = { ...created, createdAt: '2026-01-01T00:00:00.000Z', meaning: 'November local correction' };
  delete (legacy as Partial<typeof legacy>).updatedAt;
  storage.setItem('tc-lingo:cards-v1', JSON.stringify([legacy]));
  expect(loadCards()[0].meaning).toBe('November local correction');
  const merged = adapter.merge(adapter.snapshot() as VaultState, remote);
  adapter.apply(merged);
  expect(loadCards()[0].meaning).toBe('November local correction');
});

it('defers baseline persistence until the first local snapshot', () => {
  const setItem = vi.spyOn(storage, 'setItem');
  const adapter = createVaultAdapter();
  expect(setItem).not.toHaveBeenCalled();
  adapter.snapshot();
  const baseline = storage.getItem('tc-lingo:vault-baseline-v1');
  expect(baseline).toBeTruthy();
  vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
  adapter.snapshot();
  expect(storage.getItem('tc-lingo:vault-baseline-v1')).toBe(baseline);
  expect(setItem).toHaveBeenCalledOnce();
});

it.each(['snapshot', 'apply'] as const)('refuses %s until a migration baseline can be persisted', (operation) => {
  const adapter = createVaultAdapter();
  const state: VaultState = { v: 1, app: 'tc-lingo', cards: [], topics: [], attempts: [], passages: [], conversations: [], levels: [], tombstones: [] };
  const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  const perform = () => operation === 'snapshot' ? adapter.snapshot() : adapter.apply(state);
  expect(perform).toThrow('Storage full');
  expect(storage.values.size).toBe(0);
  setItem.mockRestore();
  expect(perform).not.toThrow();
  expect(storage.getItem('tc-lingo:vault-baseline-v1')).not.toBeNull();
});
