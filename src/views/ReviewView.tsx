// Retrieval practice: the review queue is snapshotted once when the view
// loads (not re-derived live from storage) so grading a card mid-session
// doesn't reshuffle the deck out from under the learner. "更新" re-snapshots
// on demand (e.g. after adding cards elsewhere).
import { useEffect, useState } from "preact/hooks";
import { RotateCw } from "lucide-preact";
import { dueCards, gradeCard } from "../lib/cards";
import type { Card, ReviewGrade } from "../types";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { t } from "../i18n";

const GRADES: ReviewGrade[] = ["again", "hard", "good", "easy"];

export function ReviewView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  const [queue, setQueue] = useState<Card[]>(() => dueCards(new Date(), settings.activeLanguage));
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [doneCount, setDoneCount] = useState(0);

  function refresh() {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setRevealed(false);
    setDoneCount(0);
  }

  useEffect(() => {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setRevealed(false);
    setDoneCount(0);
  }, [settings.activeLanguage]);

  const current = queue[index] ?? null;

  function grade(g: ReviewGrade) {
    if (!current) return;
    gradeCard(current.id, g);
    setDoneCount((n) => n + 1);
    setIndex((i) => i + 1);
    setRevealed(false);
  }

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
            <p class="review-prompt">{current.cloze || current.front}</p>

            {!revealed ? (
              <button type="button" class="primary-button" onClick={() => setRevealed(true)}>
                {t("review-reveal-answer")}
              </button>
            ) : (
              <>
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
                  {GRADES.map((g) => (
                    <button key={g} type="button" class={`grade-button grade-button-${g}`} onClick={() => grade(g)}>
                      {t(`review-grade-${g}`)}
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
