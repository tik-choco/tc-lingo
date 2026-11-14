import { afterEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';

vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useEffect: vi.fn(), useLayoutEffect: vi.fn(), useRef: () => ({ current: null }),
  useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
}));
vi.mock('../../../src/lib/network', () => ({ createAppNode: vi.fn(() => { throw new Error('No provider'); }) }));
vi.mock('../../../src/lib/mistStorage', () => ({ storageAdd: vi.fn(), storageGet: vi.fn() }));
vi.mock('../../../src/lib/sync/session', () => ({ getSyncState: () => ({ phase: 'idle' }) }));
vi.mock('../../../src/components/SyncPanel', () => ({ SyncPanel: () => null }));
vi.mock('../../../src/components/MistBuildBanner', () => ({ MistBuildBanner: () => null }));
vi.mock('../../../src/hooks/useSpeech', () => ({ useSpeech: () => ({}) }));

function find(node: any, predicate: (node: VNode<any>) => boolean): VNode<any> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } }
  else if (node && typeof node === 'object' && node.props) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('starts restoring after a fresh device confirms a vault link', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k), key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  });
  vi.stubGlobal('window', new EventTarget());
  const { SettingsView } = await import('../../../src/views/SettingsView');
  const { vault } = await import('../../../src/lib/vault');
  const { vaultMessage } = await import('@tik-choco/mistvault');
  const { getUiLanguage } = await import('../../../src/i18n');
  const handled = vi.fn();
  try {
    expect(vault.getView().mode).toBe('off');
    const tree = SettingsView({ pendingVaultCode: 'tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa', onVaultLinkHandled: handled });
    const confirm = find(tree, node => node.props.class === 'mv-confirm');
    const button = find(confirm, node => node.type === 'button' && node.props.children === vaultMessage(getUiLanguage(), 'confirm'));
    expect(button).toBeDefined();
    button!.props.onClick();
    expect(handled).toHaveBeenCalledOnce();
    expect(vault.revealCode()).toBe('tcv1-aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(vault.getView().mode).toBe('auto');
  } finally { vault.dispose(); }
});
