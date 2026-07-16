// After AI feedback, lets the learner pick which suggested mistake-derived
// flashcards to actually add to their deck (all pre-selected by default —
// this is meant to be a quick accept/reject, not another data-entry chore).
import { useState } from "preact/hooks";
import type { CardCandidate } from "../lib/parse";
import { t } from "../i18n";

export interface MistakeCardPickerProps {
  candidates: CardCandidate[];
  onAdd: (selected: CardCandidate[]) => void;
}

export function MistakeCardPicker({ candidates, onAdd }: MistakeCardPickerProps) {
  const [selected, setSelected] = useState<boolean[]>(() => candidates.map(() => true));

  function toggle(index: number) {
    setSelected((prev) => prev.map((v, i) => (i === index ? !v : v)));
  }

  function addSelected() {
    onAdd(candidates.filter((_, i) => selected[i]));
  }

  const anySelected = selected.some(Boolean);

  return (
    <div class="mistake-card-picker">
      {candidates.map((c, i) => (
        <label key={i} class="mistake-card-item">
          <input type="checkbox" checked={selected[i]} onChange={() => toggle(i)} />
          <span>
            <strong>{c.front}</strong>
            {c.reading && <span class="mistake-card-reading"> ({c.reading})</span>}
            <span class="mistake-card-meaning"> — {c.meaning}</span>
          </span>
        </label>
      ))}
      <button type="button" class="primary-button" onClick={addSelected} disabled={!anySelected}>
        {t("practice-add-selected-cards")}
      </button>
    </div>
  );
}
