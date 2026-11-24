import { MistaiError } from "@tik-choco/mistai";
import {
  loadDelegation, loadDelegationFor, normalizePairingCode, pairingRoomId, requestDelegation, saveDelegation, subscribeDelegation,
} from "@tik-choco/mistai/identity";
import type { DelegationV1 } from "@tik-choco/mistai/identity";
import { createAppNode } from "../network";
import { ensureDidIdentity, invalidateDidIdentity, SHARED_IDENTITY_CID } from "./identity";

interface DidLink {
  leafDid: string | null;
  rootDid: string | null;
  expiresAt: string | null;
  delegation: DelegationV1 | null;
  error: string | null;
}

const empty: DidLink = { leafDid: null, rootDid: null, expiresAt: null, delegation: null, error: null };
let link = empty;
let generation = 0;
let watching = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
export const getDidLink = () => link;
export function subscribeDidLink(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function publish(next: DidLink) {
  link = next;
  for (const cb of listeners) cb();
}

async function refresh() {
  const version = ++generation;
  clearTimeout(expiry);
  publish({ ...empty, leafDid: link.leafDid });
  try {
    const leaf = await ensureDidIdentity();
    const delegation = await loadDelegationFor(leaf.did);
    if (version !== generation) return;
    const remaining = delegation ? Date.parse(delegation.exp) - Date.now() : 0;
    if (delegation && remaining > 0) {
      publish({ leafDid: leaf.did, rootDid: delegation.root, expiresAt: delegation.exp, delegation, error: null });
      const checkExpiry = () => {
        const delay = Date.parse(delegation.exp) - Date.now();
        if (delay <= 0) void refresh();
        else expiry = setTimeout(checkExpiry, Math.min(delay, 2_147_483_647));
      };
      checkExpiry();
    } else publish({ ...empty, leafDid: leaf.did });
  } catch {
    if (version === generation) publish({ ...empty, error: "settings-did-identity-error" });
  }
}

export function watchDidLink(): () => void {
  watching = true;
  function changed() {
    invalidateDidIdentity();
    void refresh();
  }
  function storage(event: StorageEvent) {
    if (event.key === SHARED_IDENTITY_CID || event.key === null) changed();
  }
  window.addEventListener("storage", storage);
  const unsubscribe = subscribeDelegation(changed);
  void refresh();
  return () => {
    watching = false;
    ++generation;
    clearTimeout(expiry);
    unsubscribe();
    window.removeEventListener("storage", storage);
    publish(empty);
  };
}

export async function pairDidDelegation(code: string): Promise<void> {
  const leaf = await ensureDidIdentity();
  // requestDelegation expects a synchronous joinRoom. Our scoped handle
  // joins asynchronously. Await readiness in init so mistai can catch join
  // failures and timeout cleanup also covers a late WASM initialization.
  const createNode = () => {
    const node = createAppNode();
    let released = false;
    return {
      async init() {
        const room = await pairingRoomId(normalizePairingCode(code)!);
        await node.init();
        if (released) { node.leaveRoom(); return; }
        await node.joinRoom(room);
      },
      joinRoom() { /* Already joined during init. */ },
      leaveRoom() { released = true; node.leaveRoom(); },
      onEvent: node.onEvent.bind(node),
      sendMessage(...args: Parameters<typeof node.sendMessage>) {
        if (!released) {
          try { node.sendMessage(...args); } catch { /* mistai retries until its pairing deadline. */ }
        }
      },
    };
  };
  const delegation = await requestDelegation({ code, leaf: leaf.did, app: "tc-lingo", createNode });
  if (Date.parse(delegation.exp) <= Date.now()) throw new MistaiError("PAIRING_INVALID_DELEGATION", "Expired delegation");
  if ((await ensureDidIdentity()).did !== leaf.did) throw new Error("Leaf changed during pairing");
  saveDelegation(delegation);
  if (loadDelegation()?.sig !== delegation.sig) throw new Error("Delegation could not be saved");
  if (watching) await refresh(); // Same-tab writes do not emit the browser storage event.
}
