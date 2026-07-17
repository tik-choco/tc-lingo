// After AI feedback, lets the learner pick which suggested mistake-derived
// flashcards to actually add to their deck (all pre-selected by default —
// this is meant to be a quick accept/reject, not another data-entry chore).
// Treated as a modal for keyboard purposes (registers at SHORTCUT_PRIORITY.modal
// as a barrier) even though it renders inline in the practice flow rather than
// as a floating overlay: while it's up, app-level shortcuts must not fire, and
// Escape should back out of it just like a real dialog would.
import { useEffect, useRef, useState } from "preact/hooks";
import type { CardCandidate } from "../lib/parse";
import { t } from "../i18n";
import { SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";

export interface MistakeCardPickerProps {
  candidates: CardCandidate[];
  onAdd: (selected: CardCandidate[]) => void;
  onClose: () => void;
}

export function MistakeCardPicker({ candidates, onAdd, onClose }: MistakeCardPickerProps) {
  const [selected, setSelected] = useState<boolean[]>(() => candidates.map(() => true));

  const firstCheckboxRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    firstCheckboxRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  useShortcuts(
    SHORTCUT_PRIORITY.modal,
    (e) => {
      if (e.key === "Escape") {
        onClose();
        return true;
      }
      return false;
    },
    { modal: true },
  );

  function toggle(index: number) {
    setSelected((prev) => prev.map((v, i) => (i === index ? !v : v)));
  }

  function addSelected() {
    onAdd(candidates.filter((_, i) => selected[i]));
  }

  const anySelected = selected.some(Boolean);

  return (
    <div class="mistake-card-picker" role="dialog" aria-modal="true" aria-label={t("practice-mistake-picker-aria-label")}>
      {candidates.map((c, i) => (
        <label key={i} class="mistake-card-item">
          <input
            type="checkbox"
            checked={selected[i]}
            onChange={() => toggle(i)}
            ref={i === 0 ? firstCheckboxRef : undefined}
          />
          <span>
            <strong>{c.front}</strong>
            {c.reading && <span class="mistake-card-reading"> ({c.reading})</span>}
            <span class="mistake-card-meaning"> — {c.meaning}</span>
          </span>
        </label>
      ))}
      <div class="button-row">
        <button type="button" class="primary-button" onClick={addSelected} disabled={!anySelected}>
          {t("practice-add-selected-cards")}
        </button>
        <button type="button" class="link-button" onClick={onClose}>
          {t("practice-mistake-picker-cancel")}
        </button>
      </div>
    </div>
  );
}
