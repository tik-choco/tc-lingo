// After AI feedback, lets the learner pick which suggested mistake-derived
// flashcards to actually add to their deck (pre-selected by default — this
// is meant to be a quick accept/reject, not another data-entry chore).
// Treated as a modal for keyboard purposes (registers at SHORTCUT_PRIORITY.modal
// as a barrier) even though it renders inline in the practice flow rather than
// as a floating overlay: while it's up, app-level shortcuts must not fire, and
// Escape should back out of it just like a real dialog would.
//
// Also reused by CardsView's `lingo-card-inbox` receive UI (see
// lib/cardInbox.ts), whose candidates come from a different flow and whose
// picker needs its own wording — hence the text props below (all optional,
// defaulting to the original Practice-tab copy so that call site is
// unaffected) rather than a second, near-duplicate component.
import { useEffect, useRef, useState } from "preact/hooks";
import type { CardCandidate } from "../lib/parse";
import { t } from "../i18n";
import { SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";

export interface MistakeCardPickerProps {
  candidates: CardCandidate[];
  onAdd: (selected: CardCandidate[]) => void;
  onClose: () => void;
  /** Overrides for the practice-* i18n copy below, so a non-Practice caller
   * (CardsView's inbox) can supply its own wording without this component
   * needing to know which caller it's rendering for. */
  ariaLabel?: string;
  addLabel?: string;
  cancelLabel?: string;
  /** Parallel to `candidates`: true marks that candidate as already present
   * in the deck (a front+language match found by the caller) — such
   * candidates start unchecked and get a badge instead of being silently
   * omitted, so the learner can still force-add a near-duplicate. Omit when
   * the caller doesn't do duplicate checking (e.g. the Practice tab). */
  duplicateFlags?: boolean[];
  duplicateLabel?: string;
}

export function MistakeCardPicker({
  candidates,
  onAdd,
  onClose,
  ariaLabel,
  addLabel,
  cancelLabel,
  duplicateFlags,
  duplicateLabel,
}: MistakeCardPickerProps) {
  const [selected, setSelected] = useState<boolean[]>(() => candidates.map((_, i) => !duplicateFlags?.[i]));

  // Candidates can grow after mount (CardsView's "AIで語彙を抽出" appends to
  // the same array rather than replacing it) — extend `selected` instead of
  // losing the learner's manual toggles on the ones already shown.
  useEffect(() => {
    setSelected((prev) => candidates.map((_, i) => (i < prev.length ? prev[i] : !duplicateFlags?.[i])));
  }, [candidates.length]);

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
    <div class="mistake-card-picker" role="dialog" aria-modal="true" aria-label={ariaLabel ?? t("practice-mistake-picker-aria-label")}>
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
            {duplicateFlags?.[i] && <span class="source-badge">{duplicateLabel ?? t("cards-inbox-already-added")}</span>}
          </span>
        </label>
      ))}
      <div class="button-row">
        <button type="button" class="primary-button" onClick={addSelected} disabled={!anySelected}>
          {addLabel ?? t("practice-add-selected-cards")}
        </button>
        <button type="button" class="link-button" onClick={onClose}>
          {cancelLabel ?? t("practice-mistake-picker-cancel")}
        </button>
      </div>
    </div>
  );
}
