import { afterEach, expect, it, vi } from 'vitest';
import { addCard, gradeCard, loadCards } from '../../../src/lib/cards';
import { createVaultAdapter } from '../../../src/lib/vault/adapter';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('can checkpoint a card whose normal spaced repetition interval exceeds a year', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k), key: () => null, get length() { return values.size; },
  });
  vi.stubGlobal('window', new EventTarget());
  const adapter = createVaultAdapter();
  const card = addCard({ front: 'train', meaning: 'railway vehicle' });
  // Complete each review on its actual due date, using only public mutation APIs.
  for (let i = 0; i < 7; i++) {
    vi.setSystemTime(new Date(loadCards()[0].dueAt));
    gradeCard(card.id, 'good');
  }
  const current = loadCards()[0];
  expect(current.intervalDays).toBeGreaterThan(366);
  expect(Date.parse(current.updatedAt)).toBeLessThanOrEqual(Date.now() + 10);
  expect(() => adapter.snapshot()).not.toThrow();
  const state = adapter.parse(JSON.parse(JSON.stringify(adapter.snapshot())));
  expect(state.cards[0].dueAt).toBe(current.dueAt);
  values.clear();
  adapter.apply(state);
  expect(loadCards()[0]).toEqual(current);
});
