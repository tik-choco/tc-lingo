import { afterEach, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ createAppNode: vi.fn() }));
vi.mock('../../../src/lib/network', () => network);
vi.mock('../../../src/lib/mistStorage', () => ({ storageAdd: vi.fn(), storageGet: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it.each(['QuotaExceededError', 'SecurityError'])('keeps application imports usable with vault off and %s from storage', async (name) => {
  vi.resetModules();
  vi.stubGlobal('window', new EventTarget());
  const setItem = vi.fn((_key: string, _value: string) => { throw new DOMException('Storage unavailable', name); });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem,
    removeItem() {}, key: () => null, length: 0,
  });
  // SettingsView is eagerly imported by App, and eagerly imports this singleton.
  const loaded = import('../../../src/lib/vault/index');
  await expect(loaded).resolves.toHaveProperty('vault');
  const { vault } = await loaded;
  expect(vault.getView().status).toBe('off');
  expect(network.createAppNode).not.toHaveBeenCalled();
  expect(setItem.mock.calls.some(args => String(args[0]).includes('vault'))).toBe(false);
  vault.dispose();
});
