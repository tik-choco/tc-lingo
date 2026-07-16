// Generic localStorage read/write helpers for this app's own domain data
// (cards/topics/attempts/settings — as opposed to lib/sharedBus.ts,
// lib/appManifest.ts, lib/llmConfig.ts, which are cross-app contracts).
// Every key lives under `tc-lingo:<name>`. Reads never throw (malformed/
// foreign data silently falls back to the given default); writes never
// throw (quota errors are swallowed after a console.warn).
//
// notifyChanged() dispatches a same-tab CustomEvent (the native `storage`
// event only fires in *other* tabs) so every open view can subscribe to one
// signal regardless of which key changed.

const CHANGE_EVENT = "tc-lingo-data-changed";

export function storageKey(name: string): string {
  return `tc-lingo:${name}`;
}

export function loadJson<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(name));
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(name: string, value: unknown): void {
  try {
    localStorage.setItem(storageKey(name), JSON.stringify(value));
  } catch (error) {
    console.warn(`tc-lingo: failed to persist "${name}"`, error);
  }
  notifyChanged();
}

function notifyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch (error) {
    console.warn("tc-lingo: failed to dispatch change event", error);
  }
}

/** Subscribes to any local write (same tab) or cross-tab `storage` event.
 * Returns an unsubscribe function. */
export function subscribeStorage(cb: () => void): () => void {
  function onLocal() {
    cb();
  }
  function onStorage(event: StorageEvent) {
    if (event.key && event.key.startsWith("tc-lingo:")) cb();
  }
  window.addEventListener(CHANGE_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}

export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the Math.random fallback below
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
