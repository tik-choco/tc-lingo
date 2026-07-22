// CardsView's "類似カードを整理" cleanup tool: lets the learner review and
// selectively accept LLM-proposed merge groups (see lib/llm.ts
// requestCardMerges) before anything is actually merged. Modeled on
// MistakeCardPicker (same modal keyboard handling, same "pre-selected by
// default — quick accept/reject" philosophy), but a separate component
// since a merge group (several original cards -> one proposed replacement)
// has no equivalent in MistakeCardPicker's flat candidate list.
import { useEffect, useRef, useState } from "preact/hooks";
import type { CardMergeGroup } from "../lib/parse";
import type { Card } from "../types";
import { t } from "../i18n";
import { SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";

export interface CardMergePanelProps {
  groups: CardMergeGroup[];
  cardsById: Map<string, Card>;
  onMerge: (accepted: CardMergeGroup[]) => void;
  onClose: () => void;
}

export function CardMergePanel({ groups, cardsById, onMerge, onClose }: CardMergePanelProps) {
  const [selected, setSelected] = useState<boolean[]>(() => groups.map(() => true));

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

  function applyMerge() {
    onMerge(groups.filter((_, i) => selected[i]));
  }

  const anySelected = selected.some(Boolean);

  return (
    <div class="card-merge-panel" role="dialog" aria-modal="true" aria-label={t("cards-merge-aria-label")}>
      {groups.map((group, i) => {
        const originals = group.cardIds.map((id) => cardsById.get(id)).filter((c): c is Card => c !== undefined);
        return (
          <label key={i} class="card-merge-group">
            <input
              type="checkbox"
              checked={selected[i]}
              onChange={() => toggle(i)}
              ref={i === 0 ? firstCheckboxRef : undefined}
            />
            <div class="card-merge-group-body">
              <p class="card-merge-section-label">{t("cards-merge-original-label")}</p>
              <ul class="card-merge-originals">
                {originals.map((c) => (
                  <li key={c.id}>
                    <strong>{c.front}</strong>
                    {c.reading && <span class="mistake-card-reading"> ({c.reading})</span>}
                    <span class="mistake-card-meaning"> — {c.meaning}</span>
                  </li>
                ))}
              </ul>
              <p class="card-merge-section-label">{t("cards-merge-preview-label")}</p>
              <div class="card-merge-preview">
                <p>
                  <strong>{group.merged.front}</strong>
                  {group.merged.reading && <span class="mistake-card-reading"> ({group.merged.reading})</span>}
                  <span class="mistake-card-meaning"> — {group.merged.meaning}</span>
                </p>
                {group.merged.exampleSentence && <p class="hint-text">{group.merged.exampleSentence}</p>}
                {group.merged.context && <p class="hint-text">{group.merged.context}</p>}
              </div>
              {group.reason && <p class="card-merge-reason">{group.reason}</p>}
            </div>
          </label>
        );
      })}
      <div class="button-row">
        <button type="button" class="primary-button" onClick={applyMerge} disabled={!anySelected}>
          {t("cards-merge-apply")}
        </button>
        <button type="button" class="link-button" onClick={onClose}>
          {t("cards-merge-cancel")}
        </button>
      </div>
    </div>
  );
}
