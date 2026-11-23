// Generic localStorage read/write helpers for this app's own domain data
// (cards/topics/attempts/settings — as opposed to lib/sharedBus.ts,
// lib/appManifest.ts, lib/llmConfig.ts, which are cross-app contracts).
// Every key lives under `tc-lingo:<name>`. Reads never throw (malformed/
// foreign data silently falls back to the given default); writes normally
// swallow quota errors after a console.warn, unless the caller opts in.
//
// notifyStorageChanged() dispatches a same-tab CustomEvent (the native `storage`
// event only fires in *other* tabs) so every open view can subscribe to one
// signal regardless of which key changed.

const CHANGE_EVENT = "tc-lingo-data-changed";

export interface StorageWriteOptions {
  source?: "vault";
  throwOnError?: boolean;
}

type StorageChange = { name: string; source: "local" | "vault" | "external" };

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

export function saveJson(name: string, value: unknown, options?: StorageWriteOptions): void {
  try {
    localStorage.setItem(storageKey(name), JSON.stringify(value));
  } catch (error) {
    if (options?.throwOnError) throw error;
    console.warn(`tc-lingo: failed to persist "${name}"`, error);
  }
  notifyStorageChanged(name, options?.source ?? "local");
}

export function notifyStorageChanged(name: string, source: "local" | "vault"): void {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { name, source } }));
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

/** Subscribes to named writes while preserving the general refresh event. */
export function subscribeStorageChanges(cb: (change: StorageChange) => void): () => void {
  function onLocal(event: Event) {
    const detail = (event as CustomEvent<StorageChange>).detail;
    if (detail && typeof detail.name === "string") cb(detail);
  }
  function onStorage(event: StorageEvent) {
    if (event.key?.startsWith("tc-lingo:")) {
      cb({ name: event.key.slice("tc-lingo:".length), source: "external" });
    }
  }
  window.addEventListener(CHANGE_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}

/** Advances an edit beyond the previous revision, even within one millisecond. */
export function nextUpdatedAt(previous?: string, now: Date = new Date()): string {
  const previousMs = previous ? Date.parse(previous) : NaN;
  const time = Number.isFinite(previousMs) ? Math.max(now.getTime(), previousMs + 1) : now.getTime();
  return new Date(time).toISOString();
}

/** Persist once so legacy records retain the same revision on later loads. */
export function legacyBaseline(strict = false): string {
  const name = "vault-baseline-v1";
  const saved = loadJson<unknown>(name, null);
  if (typeof saved === "string" && Number.isSafeInteger(Date.parse(saved)) && Date.parse(saved) >= 0 &&
    Date.parse(saved) <= Date.now() + 366 * 86400000) return saved;
  const baseline = new Date().toISOString();
  try {
    localStorage.setItem(storageKey(name), JSON.stringify(baseline));
  } catch (error) {
    if (strict) throw error;
  }
  return baseline;
}

/** Local loading supplies a migration revision; remote sanitizers stay pure. */
export function loadDomainJson(name: string): unknown {
  const baseline = legacyBaseline();
  const raw = loadJson<unknown>(name, []);
  if (!Array.isArray(raw)) return raw;
  const newest = (value: unknown, depth = 0): number => {
    if (!value || typeof value !== "object" || depth > 16) return 0;
    return Object.entries(value).reduce((max, [key, child]) => {
      if ((key === "updatedAt" || key === "askedAt" || key === "endedAt" || key === "createdAt") && typeof child === "string") {
        const time = Date.parse(child);
        if (Number.isSafeInteger(time) && time >= 0 && time <= Date.now() + 366 * 86400000) max = Math.max(max, time);
      }
      return Math.max(max, newest(child, depth + 1));
    }, 0);
  };
  return raw.map((item: unknown) => item && typeof item === "object" && !("updatedAt" in item)
    ? { ...item, updatedAt: new Date(Math.max(Date.parse(baseline), newest(item))).toISOString() }
    : item);
}

export interface JsonWrite {
  name: string;
  value: unknown;
  /** Re-read and check revisions immediately before this key is written. */
  refresh?: () => unknown;
}

/** A synchronous batch with conditional rollback that preserves later edits. */
export function saveJsonBatch(writes: JsonWrite[], options?: StorageWriteOptions): void {
  const completed: { name: string; before: string | null; after: string }[] = [];
  try {
    const prepared = writes.map((write) => ({ ...write, after: JSON.stringify(write.value), before: localStorage.getItem(storageKey(write.name)) }));
    // Restore batches grow first, shrink last, leaving room to roll back.
    if (options?.source === "vault") prepared.sort((a, b) =>
      Number(a.after.length < (a.before?.length ?? 0)) - Number(b.after.length < (b.before?.length ?? 0)));
    for (const write of prepared) {
      const after = write.refresh ? JSON.stringify(write.refresh()) : write.after;
      const before = localStorage.getItem(storageKey(write.name));
      if (before === after) continue;
      localStorage.setItem(storageKey(write.name), after);
      completed.push({ name: write.name, before, after });
      notifyStorageChanged(write.name, options?.source ?? "local");
    }
  } catch (error) {
    const rollback = (write: typeof completed[number]) => {
      const key = storageKey(write.name);
      if (localStorage.getItem(key) !== write.after) return;
      if (write.before === null) localStorage.removeItem(key);
      else localStorage.setItem(key, write.before);
      notifyStorageChanged(write.name, options?.source ?? "local");
    };
    const retry: typeof completed = [];
    for (const write of completed.reverse()) {
      try { rollback(write); } catch { retry.push(write); }
    }
    const errors: unknown[] = [];
    for (const write of retry) {
      try { rollback(write); } catch (rollbackError) { errors.push(rollbackError); }
    }
    if (errors.length) throw new AggregateError([error, ...errors], "Vault restore rollback failed");
    if (options?.throwOnError) throw error;
    console.warn("tc-lingo: failed to persist data", error);
  }
}

export function validId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0 && id.length <= 512;
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
