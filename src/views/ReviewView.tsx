// Retrieval practice: the review queue is snapshotted once when the view
// loads (not re-derived live from storage) so grading a card mid-session
// doesn't reshuffle the deck out from under the learner. "更新" re-snapshots
// on demand (e.g. after adding cards elsewhere).
//
// Grading is automatic: the learner types (or leaves blank) their recalled
// answer, "check" compares it against `front` (judgeAnswer) and combines that
// with how long it took (autoGrade) to derive a ReviewGrade, which is applied
// via gradeCard immediately. There's no manual again/hard/good/easy choice.
// When an LLM connection exists, a non-blank answer that fails the strict
// check gets a second opinion (judgeReviewAnswer) so synonyms/equivalent
// phrasings count as correct instead of lapsing the card.
import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, RotateCw, Square, Volume2 } from "lucide-preact";
import { dueCards, gradeCard } from "../lib/cards";
import { diffChars } from "../lib/diff";
import { GrammarExplain } from "../components/GrammarExplain";
import { SpellingDrill } from "../components/SpellingDrill";
import type { AnswerJudgement } from "../lib/srs";
import { autoGrade, judgeAnswer, scheduleReview } from "../lib/srs";
import type { Card } from "../types";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { judgeReviewAnswer } from "../lib/llm";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { t } from "../i18n";
import { isEditableTarget, SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";
import { useSpeech } from "../hooks/useSpeech";

export function ReviewView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const { connection } = useLlmConnection();

  const [queue, setQueue] = useState<Card[]>(() => dueCards(new Date(), settings.activeLanguage));
  const [index, setIndex] = useState(0);
  // llmNote/llmAccepted come from the optional LLM second-opinion pass in
  // check(): the note is shown in both directions (why an alternative counts,
  // or how a wrong answer differs), llmAccepted marks a rescued judgement.
  const [result, setResult] = useState<{ judgement: AnswerJudgement; days: number; llmAccepted: boolean; llmNote: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  // Optional retrieval-practice typing: the learner can type their recalled
  // answer before checking, and it's compared (via judgeAnswer, then a char
  // diff for display) against `front` once checked. Cleared whenever the
  // card changes.
  const [typedAnswer, setTypedAnswer] = useState("");

  function refresh() {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setResult(null);
    setDoneCount(0);
    setTypedAnswer("");
    shownAtRef.current = performance.now();
  }

  useEffect(() => {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setResult(null);
    setDoneCount(0);
    setTypedAnswer("");
    shownAtRef.current = performance.now();
  }, [settings.activeLanguage]);

  const current = queue[index] ?? null;
  const cardLanguage = current?.language || settings.activeLanguage;

  const speech = useSpeech();

  // Response-time measurement: reset whenever a fresh, unanswered card is
  // shown, so `check()` can measure how long the learner took to answer.
  const shownAtRef = useRef<number>(performance.now());

  useEffect(() => {
    shownAtRef.current = performance.now();
  }, [current?.id]);

  async function check() {
    if (!current || result || checking) return;
    // Measured before the (possibly slow) LLM pass so its latency never
    // penalizes the learner's speed-based grade.
    const elapsed = performance.now() - shownAtRef.current;
    let judgement = judgeAnswer(typedAnswer, current.front);
    let llmAccepted = false;
    let llmNote = "";
    if (judgement === "wrong" && typedAnswer.trim() && connection) {
      setChecking(true);
      try {
        const verdict = await judgeReviewAnswer({
          connection,
          targetLanguage: cardLanguage,
          nativeLanguage: settings.nativeLanguage,
          card: {
            front: current.front,
            reading: current.reading,
            meaning: current.meaning,
            context: current.context,
            cloze: current.cloze,
          },
          typedAnswer: typedAnswer.trim(),
        });
        llmNote = verdict.note;
        if (verdict.acceptable) {
          judgement = "correct";
          llmAccepted = true;
        }
      } catch {
        // Best-effort: on any LLM failure the strict judgement stands.
      } finally {
        setChecking(false);
      }
    }
    const grade = autoGrade(judgement, elapsed);
    const days = scheduleReview(current, grade).intervalDays;
    gradeCard(current.id, grade);
    setDoneCount((n) => n + 1);
    setResult({ judgement, days, llmAccepted, llmNote });
  }

  function next() {
    setIndex((i) => i + 1);
    setResult(null);
    setTypedAnswer("");
  }

  // Keep keyboard-only review flowing without a mouse: the answer input is
  // focused whenever a fresh, unchecked card is on screen, and once checked
  // (the input unmounts) focus moves to the "next" button so Enter/Space and
  // the shortcut below all have somewhere to land.
  const answerInputRef = useRef<HTMLInputElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!result) answerInputRef.current?.focus();
  }, [current?.id, result]);

  useEffect(() => {
    // On a miss, the SpellingDrill below focuses its own input instead, so
    // the learner can start retyping the correct answer immediately.
    if (result?.judgement === "correct") nextButtonRef.current?.focus();
  }, [current?.id, result]);

  // View-priority shortcuts: before check, Enter/Space (outside any editable
  // field — the input's own onKeyDown already handles Enter) checks the
  // answer; after check, Enter/Space advances to the next card. Grading is
  // now automatic, so this no longer needs to shadow the app-level 1-5
  // tab-switch shortcut — digits fall through to tab switching as usual.
  useShortcuts(SHORTCUT_PRIORITY.view, (e) => {
    if (!current) return false;
    if (isEditableTarget(e.target)) return false;
    // A focused button already fires check()/next() via its native click —
    // handling the same keydown here would double-grade or double-advance.
    if (e.target instanceof HTMLButtonElement) return false;
    if (e.key === "Enter" || e.key === " ") {
      if (result) next();
      else check();
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

            {!result ? (
              <div class="review-answer-form">
                <input
                  ref={answerInputRef}
                  type="text"
                  class="review-answer-input"
                  value={typedAnswer}
                  placeholder={t("review-answer-input-placeholder")}
                  onInput={(e) => setTypedAnswer((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") check();
                  }}
                  disabled={checking}
                />
                <button type="button" class="primary-button" onClick={check} disabled={checking}>
                  {checking ? (
                    t("review-checking")
                  ) : (
                    <>
                      {typedAnswer.trim() ? t("review-check-answer") : t("review-reveal-answer")} <kbd class="kbd">Enter</kbd>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <>
                <p class={`review-result review-result-${result.judgement}`}>
                  {t(`review-result-${result.judgement}`, { days: result.days })}
                </p>
                {result.llmNote && (
                  <p class={result.llmAccepted ? "hint-text status-ok" : "hint-text"}>
                    {t("review-llm-note", { note: result.llmNote })}
                  </p>
                )}
                {typedAnswer.trim() && result.judgement !== "correct" && (
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
                )}
                <div class="review-answer">
                  <p class="review-answer-front">
                    {current.front}
                    {current.reading && <span class="review-answer-reading"> ({current.reading})</span>}
                    {speech.supported && (
                      <button
                        type="button"
                        class="speak-button"
                        onClick={() => speech.speak(current.front, cardLanguage, `${current.id}:front`)}
                        disabled={speech.loadingId === `${current.id}:front`}
                        aria-pressed={speech.speakingId === `${current.id}:front`}
                        aria-label={
                          speech.speakingId === `${current.id}:front` ? t("review-speak-front-stop") : t("review-speak-front")
                        }
                        title={speech.speakingId === `${current.id}:front` ? t("review-speak-front-stop") : t("review-speak-front")}
                      >
                        {speech.loadingId === `${current.id}:front` ? (
                          <Loader2 size={14} class="speak-button-spin" />
                        ) : speech.speakingId === `${current.id}:front` ? (
                          <Square size={14} />
                        ) : (
                          <Volume2 size={14} />
                        )}
                      </button>
                    )}
                  </p>
                  <p class="review-answer-meaning">{current.meaning}</p>
                  {current.exampleSentence && (
                    <p class="review-answer-example">
                      {current.exampleSentence}
                      {speech.supported && (
                        <button
                          type="button"
                          class="speak-button"
                          onClick={() => speech.speak(current.exampleSentence, cardLanguage, `${current.id}:example`)}
                          disabled={speech.loadingId === `${current.id}:example`}
                          aria-pressed={speech.speakingId === `${current.id}:example`}
                          aria-label={
                            speech.speakingId === `${current.id}:example`
                              ? t("review-speak-example-stop")
                              : t("review-speak-example")
                          }
                          title={
                            speech.speakingId === `${current.id}:example`
                              ? t("review-speak-example-stop")
                              : t("review-speak-example")
                          }
                        >
                          {speech.loadingId === `${current.id}:example` ? (
                            <Loader2 size={14} class="speak-button-spin" />
                          ) : speech.speakingId === `${current.id}:example` ? (
                            <Square size={14} />
                          ) : (
                            <Volume2 size={14} />
                          )}
                        </button>
                      )}
                    </p>
                  )}
                  {current.context && <p class="review-answer-context">{current.context}</p>}
                  {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
                  {current.exampleSentence && (
                    <GrammarExplain sentence={current.exampleSentence} targetLanguage={cardLanguage} />
                  )}
                </div>
                {result.judgement !== "correct" &&
                  // Copy-typing practice for what was just missed (live diff,
                  // cleared on exact match) — same drill as the practice tab.
                  // Short fronts are worth repeating; long phrase/sentence
                  // fronts are typed once (sentence mode) to avoid tedium.
                  ([...current.front].length <= 12 ? (
                    <SpellingDrill key={current.id} words={[{ attempted: typedAnswer.trim(), correct: current.front }]} />
                  ) : (
                    <SpellingDrill
                      key={current.id}
                      words={[]}
                      sentences={[{ attempted: typedAnswer.trim(), correct: current.front }]}
                    />
                  ))}
                <div class="review-next-row">
                  <button type="button" class="primary-button" ref={nextButtonRef} onClick={next}>
                    {t("review-next")} <kbd class="kbd">Enter</kbd>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
