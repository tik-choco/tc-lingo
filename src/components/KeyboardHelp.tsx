// Keyboard shortcut cheat-sheet, opened from the header button or "?" (see
// app.tsx). Registered as a `modal` shortcut handler at overlay priority so
// it swallows every key while open (Escape/"?" close it; nothing below it —
// view or app-level shortcuts — can fire until it's dismissed).
import { useEffect, useRef } from "preact/hooks";
import { X } from "lucide-preact";
import { SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";
import { t } from "../i18n";

interface KeyboardHelpProps {
  onClose: () => void;
}

// Each row's `keys` renders as a sequence of segments: plain strings become
// a `<kbd>` chip, segments wrapped in `sep()` render as bare connector text
// (e.g. "–" for a range, "+" for a chord, "/" for alternatives).
type KeySegment = string | { sep: string };

function sep(text: string): KeySegment {
  return { sep: text };
}

interface ShortcutRow {
  keys: KeySegment[];
  descriptionKey: string;
}

const ROWS: ShortcutRow[] = [
  { keys: ["1", sep("–"), "7"], descriptionKey: "app-kbd-tabs" },
  { keys: ["?"], descriptionKey: "app-kbd-toggle-help" },
  { keys: ["Esc"], descriptionKey: "app-kbd-close-dialogs" },
  { keys: ["Enter", sep("/"), "Space"], descriptionKey: "app-kbd-review-reveal" },
  { keys: ["Enter", sep("/"), "Space"], descriptionKey: "app-kbd-review-next" },
  { keys: ["Ctrl", sep("+"), "Enter"], descriptionKey: "app-kbd-submit" },
];

export function KeyboardHelp({ onClose }: KeyboardHelpProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useShortcuts(
    SHORTCUT_PRIORITY.overlay,
    (e) => {
      if (e.key === "Escape" || e.key === "?") {
        onClose();
        return true;
      }
      return false;
    },
    { modal: true },
  );

  return (
    <div class="kbd-help-overlay" onClick={onClose}>
      <div
        class="kbd-help-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("app-kbd-help-title")}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="kbd-help-header">
          <h2>{t("app-kbd-help-title")}</h2>
          <button type="button" class="kbd-help-close" onClick={onClose} aria-label={t("app-kbd-close")}>
            <X size={18} />
          </button>
        </div>
        <div class="kbd-help-list">
          {ROWS.map((row) => (
            <div class="kbd-help-row" key={row.descriptionKey}>
              <span class="kbd-help-keys">
                {row.keys.map((segment, i) =>
                  typeof segment === "string" ? (
                    <kbd class="kbd" key={i}>
                      {segment}
                    </kbd>
                  ) : (
                    <span class="kbd-help-sep" key={i}>
                      {segment.sep}
                    </span>
                  ),
                )}
              </span>
              <span class="kbd-help-desc">{t(row.descriptionKey)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
