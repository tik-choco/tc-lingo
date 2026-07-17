// Retrieval practice: the review queue is snapshotted once when the view
// loads (not re-derived live from storage) so grading a card mid-session
// doesn't reshuffle the deck out from under the learner. "更新" re-snapshots
// on demand (e.g. after adding cards elsewhere).
import { useEffect, useRef, useState } from "preact/hooks";
import { RotateCw } from "lucide-preact";
import { dueCards, gradeCard } from "../lib/cards";
import { diffChars } from "../lib/diff";
import type { Card, ReviewGrade } from "../types";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { t } from "../i18n";
import { isEditableTarget, SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";

const GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];
const GRADE_KEYS = "1234";

export function ReviewView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  const [queue, setQueue] = useState<Card[]>(() => dueCards(new Date(), settings.activeLanguage));
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  // Optional retrieval-practice typing: the learner can type their recalled
  // answer before revealing, and it's compared (trim-equality, else a char
  // diff) against `front` once revealed. Cleared whenever the card changes.
  const [typedAnswer, setTypedAnswer] = useState("");

  function refresh() {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setRevealed(false);
    setDoneCount(0);
    setTypedAnswer("");
  }

  useEffect(() => {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setRevealed(false);
    setDoneCount(0);
    setTypedAnswer("");
  }, [settings.activeLanguage]);

  const current = queue[index] ?? null;

  function grade(g: ReviewGrade) {
    if (!current) return;
    gradeCard(current.id, g);
    setDoneCount((n) => n + 1);
    setIndex((i) => i + 1);
    setRevealed(false);
    setTypedAnswer("");
  }

  // Keep keyboard-only review flowing without a mouse: the answer input is
  // focused whenever a fresh, unrevealed card is on screen, and once
  // revealed (the input unmounts) focus moves to the "good" grade button so
  // Enter/Space and the 1-4 grade shortcut below all have somewhere to land.
  const answerInputRef = useRef<HTMLInputElement>(null);
  const goodButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!revealed) answerInputRef.current?.focus();
  }, [current?.id, revealed]);

  useEffect(() => {
    if (revealed) goodButtonRef.current?.focus();
  }, [current?.id, revealed]);

  // View-priority shortcuts: before reveal, Enter/Space (outside any
  // editable field — the input's own onKeyDown already handles Enter)
  // reveals the answer; after reveal, 1-4 grade the card. This deliberately
  // shadows the app-level 1-5 tab-switch shortcut while a card is revealed
  // (view priority > app priority) — that's intended so grading doesn't
  // accidentally jump tabs.
  useShortcuts(SHORTCUT_PRIORITY.view, (e) => {
    if (!current) return false;
    if (isEditableTarget(e.target)) return false;
    if (!revealed) {
      if (e.key === "Enter" || e.key === " ") {
        setRevealed(true);
        return true;
      }
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const gradeIndex = GRADE_KEYS.indexOf(e.key);
    if (gradeIndex !== -1) {
      grade(GRADES[gradeIndex]);
      return true;
    }
    return false;
  });

  return (
    <div class="view-container review-view">
      <section class="card-panel">
        <div class="topic-header">
          <h2>{t("review-title")}</h2>
          <button type="button" class="link-button" onClick={refresh} title={t("review-refresh-title")}>
            <RotateCw size={14} />
          </button>
        </div>

        {queue.length === 0 ? (
          <p class="hint-text">{t("review-empty-hint")}</p>
        ) : !current ? (
          <p class="hint-text status-ok">{t("review-session-done", { count: doneCount })}</p>
        ) : (
          <div class="review-card">
            <p class="review-progress">
              {index + 1} / {queue.length}{" "}
              {settings.targetLanguages.length > 1 && current.language && (
                <span class="language-badge">{languageDisplayName(current.language)}</span>
              )}
            </p>
            {current.cloze ? (
              <>
                <p class="review-prompt">{current.cloze}</p>
                <p class="review-prompt-hint">
                  <span class="review-hint-label">{t("review-hint-label")}</span> {current.meaning}
                </p>
              </>
            ) : (
              <>
                <p class="review-recall-instruction">{t("review-recall-instruction")}</p>
                <p class="review-prompt">{current.meaning}</p>
                {current.context && <p class="review-prompt-hint">{current.context}</p>}
              </>
            )}

            {!revealed ? (
              <div class="review-answer-form">
                <input
                  ref={answerInputRef}
                  type="text"
                  class="review-answer-input"
                  value={typedAnswer}
                  placeholder={t("review-answer-input-placeholder")}
                  onInput={(e) => setTypedAnswer((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setRevealed(true);
                  }}
                />
                <button type="button" class="primary-button" onClick={() => setRevealed(true)}>
                  {t("review-reveal-answer")} <kbd class="kbd">Enter</kbd>
                </button>
              </div>
            ) : (
              <>
                {typedAnswer.trim() &&
                  (typedAnswer.trim() === current.front.trim() ? (
                    <p class="hint-text status-ok">{t("review-answer-correct")}</p>
                  ) : (
                    <div class="review-answer-compare">
                      <p class="review-answer-compare-label">{t("review-answer-your-answer")}</p>
                      <p class="feedback-diff">
                        {diffChars(typedAnswer.trim(), current.front).map((chunk, i) => (
                          <span key={i} class={chunk.op === "same" ? undefined : `diff-${chunk.op}`}>
                            {chunk.text}
                          </span>
                        ))}
                      </p>
                    </div>
                  ))}
                <div class="review-answer">
                  <p class="review-answer-front">
                    {current.front}
                    {current.reading && <span class="review-answer-reading"> ({current.reading})</span>}
                  </p>
                  <p class="review-answer-meaning">{current.meaning}</p>
                  {current.exampleSentence && <p class="review-answer-example">{current.exampleSentence}</p>}
                  {current.context && <p class="review-answer-context">{current.context}</p>}
                </div>
                <div class="grade-buttons">
                  {GRADES.map((g, i) => (
                    <button
                      key={g}
                      type="button"
                      class={`grade-button grade-button-${g}`}
                      onClick={() => grade(g)}
                      ref={g === "good" ? goodButtonRef : undefined}
                    >
                      <kbd class="kbd">{i + 1}</kbd> {t(`review-grade-${g}`)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
