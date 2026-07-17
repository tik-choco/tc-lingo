import { useEffect, useRef } from "preact/hooks";
import type { ShortcutHandler } from "../lib/keyboard";
import { registerShortcutHandler } from "../lib/keyboard";

/**
 * Registers a keyboard shortcut handler at the given priority (see
 * SHORTCUT_PRIORITY in lib/keyboard.ts) for the lifetime of the component.
 * The handler itself is kept in a ref so callers can pass a fresh inline
 * closure on every render without re-registering — only a change to
 * `priority` or `opts.modal` tears down and re-registers.
 */
export function useShortcuts(priority: number, handler: ShortcutHandler, opts?: { modal?: boolean }): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const modal = opts?.modal ?? false;

  useEffect(() => {
    return registerShortcutHandler(priority, (e) => handlerRef.current(e), { modal });
  }, [priority, modal]);
}
