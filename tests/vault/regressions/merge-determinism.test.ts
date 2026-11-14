import { expect, it, vi } from 'vitest';
import './setup';
import { createVaultAdapter, type VaultState } from '../../../src/lib/vault/adapter';

it('merges the same checkpoint inputs independently of the executing device clock', () => {
  const adapter = createVaultAdapter();
  const empty = adapter.snapshot() as VaultState;
  const remote = structuredClone(empty);
  const deletedAt = '2026-08-16T12:00:00.000Z';
  remote.tombstones.push({ store: 'cards', id: 'deleted-card', deletedAt });
  const expiry = Date.parse(deletedAt) + 90 * 24 * 60 * 60 * 1000;
  vi.setSystemTime(expiry - 30_000);
  const firstDevice = adapter.merge(empty, remote);
  // A second device runs the identical inputs with a one-minute clock skew.
  vi.setSystemTime(expiry + 30_000);
  const secondDevice = adapter.merge(empty, remote);
  expect(secondDevice).toEqual(firstDevice);
});

it('merge(x, x) retains its state when tombstones age after capture', () => {
  const adapter = createVaultAdapter();
  const state = adapter.snapshot() as VaultState;
  state.tombstones.push({ store: 'cards', id: 'deleted-card', deletedAt: '2026-08-16T12:00:00.000Z' });
  vi.setSystemTime(new Date('2026-11-14T12:00:00.001Z'));
  expect(adapter.merge(state, state)).toEqual(state);
});
