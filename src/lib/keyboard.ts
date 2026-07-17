// A priority-scoped, barrier-aware keyboard shortcut registry.
//
// There is exactly one `window` "keydown" listener (attached lazily, on the
// first registration). Handlers register with a numeric priority — see
// SHORTCUT_PRIORITY — and on every keydown they are walked from highest
// priority to lowest (newest-registered-first within the same priority)
// until one returns `true` ("I handled this"), at which point
// `preventDefault()` is called and the walk stops.
//
// Modals are a hard barrier, not just another priority tier: a handler
// registered with `{ modal: true }` that returns `false` stops the walk
// right there — shortcuts belonging to views/app layers underneath a modal
// must never fire while it's open — but does *not* preventDefault, so
// normal typing inside the modal's own inputs keeps working.
//
// Each handler is responsible for its own guards (e.g. ignoring keydowns
// that landed in an editable element via `isEditableTarget`); this registry
// only owns ordering and the modal barrier.

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export type ShortcutHandler = (e: KeyboardEvent) => boolean;

export const SHORTCUT_PRIORITY = { app: 10, view: 20, modal: 30, overlay: 40 } as const;

interface RegisteredHandler {
  priority: number;
  handler: ShortcutHandler;
  modal: boolean;
  order: number;
}

const handlers: RegisteredHandler[] = [];
let nextOrder = 0;
let listenerAttached = false;

function handleKeyDown(e: KeyboardEvent) {
  // Highest priority first; within a priority, newest registration first.
  const sorted = [...handlers].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.order - a.order;
  });
  for (const entry of sorted) {
    const handled = entry.handler(e);
    if (handled) {
      e.preventDefault();
      return;
    }
    if (entry.modal) {
      // A modal barrier: even though it didn't handle this key itself,
      // nothing below it should see the event.
      return;
    }
  }
}

function ensureListener() {
  if (listenerAttached) return;
  window.addEventListener("keydown", handleKeyDown);
  listenerAttached = true;
}

export function registerShortcutHandler(
  priority: number,
  handler: ShortcutHandler,
  opts?: { modal?: boolean },
): () => void {
  ensureListener();
  const entry: RegisteredHandler = { priority, handler, modal: opts?.modal ?? false, order: nextOrder++ };
  handlers.push(entry);
  return () => {
    const i = handlers.indexOf(entry);
    if (i !== -1) handlers.splice(i, 1);
  };
}
