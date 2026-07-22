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
// check gets a second opinion (judgeReviewAnswer): synonyms/equivalent
// phrasings count as correct, and a right-word-wrong-form slip (tense,
// plural, conjugation, ...) counts as "near" (partial credit) instead of
// lapsing the card outright.
//
// Three more LLM-connection-gated, best-effort niceties layered on top,
// all designed to cost zero added latency by working during the idle time
// the learner spends on whichever card is currently shown:
// - A miss also gets requeued a few cards later in *this session's* queue
//   (interleaving — see REQUEUE_OFFSET), independent of its normal SRS
//   reschedule to tomorrow-or-later.
// - lib/cards.ts's dueCards() already orders by lapses first, so
//   consistently-hard cards front-load the session.
// - lib/reviewClozeVariation.ts prefetches a fresh example-sentence variant
//   for a card that's been seen before, so repeat reviews don't always show
//   the exact same sentence (see displayCloze).
import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, RotateCw, Square, Volume2 } from "lucide-preact";
import { dueCards, gradeCard } from "../lib/cards";
import { CardFront } from "../components/CardFront";
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
import { connectionForTask } from "../lib/llmConnection";
import { checkCardConsistency } from "../lib/reviewConsistencyCheck";
import { generateClozeVariation } from "../lib/reviewClozeVariation";
import { t } from "../i18n";
import { isEditableTarget, SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";
import { useSpeech } from "../hooks/useSpeech";

/** How many cards later a missed card reappears in *this session's* queue
 * (interleaving) — separate from its persisted SRS reschedule (still
 * tomorrow-or-later via scheduleReview/gradeCard). Small enough that the
 * retry stays close enough to be useful, large enough that it isn't just
 * the very next card (no interleaving benefit from immediate repetition). */
const REQUEUE_OFFSET = 4;

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
  // Ephemeral, session-only cloze variations (lib/reviewClozeVariation.ts),
  // keyed by card id — never persisted, see the prefetch effect below.
  const [clozeVariations, setClozeVariations] = useState<Record<string, string>>({});
  // Toggle-on-demand example-sentence translation, same idea as PracticeView's
  // promptTranslationRevealed — reset whenever the shown card changes.
  const [exampleTranslationRevealed, setExampleTranslationRevealed] = useState(false);

  function refresh() {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setResult(null);
    setDoneCount(0);
    setTypedAnswer("");
    setClozeVariations({});
    setExampleTranslationRevealed(false);
    shownAtRef.current = performance.now();
  }

  useEffect(() => {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setResult(null);
    setDoneCount(0);
    setTypedAnswer("");
    setClozeVariations({});
    setExampleTranslationRevealed(false);
    shownAtRef.current = performance.now();
  }, [settings.activeLanguage]);

  const current = queue[index] ?? null;
  const cardLanguage = current?.language || settings.activeLanguage;
  // Ephemeral variation (lib/reviewClozeVariation.ts) when one's ready for
  // this card, else the card's own stored cloze — never both/blended.
  const displayCloze = current ? (clozeVariations[current.id] ?? current.cloze) : "";

  const speech = useSpeech();

  // Response-time measurement: reset whenever a fresh, unanswered card is
  // shown, so `check()` can measure how long the learner took to answer.
  const shownAtRef = useRef<number>(performance.now());

  useEffect(() => {
    shownAtRef.current = performance.now();
  }, [current?.id]);

  // Background QA: while the learner is occupied with `current`, spend that
  // idle time checking the *next* queued card's front/cloze consistency
  // (lib/reviewConsistencyCheck.ts) so a bad pairing is already fixed by the
  // time they reach it, instead of adding latency right when they need the
  // card. Fire-and-forget; a fix patches this snapshot's `queue` in place
  // (never re-fetched from storage) so it's picked up without reshuffling
  // the deck — see this file's header comment on why the queue stays static.
  useEffect(() => {
    const next = queue[index + 1];
    if (!next) return;
    let cancelled = false;
    void checkCardConsistency(next, next.language || settings.activeLanguage).then((fixed) => {
      if (cancelled || !fixed) return;
      setQueue((prev) => prev.map((c) => (c.id === fixed.id ? fixed : c)));
    });
    return () => {
      cancelled = true;
    };
    // Depends on the *id* of the next card, not `queue` itself — `queue`'s
    // reference changes on every grade/fix (including this effect's own
    // setQueue below), which would otherwise refire this on every card.
  }, [index, queue[index + 1]?.id, settings.activeLanguage]);

  // Same idle-time-of-the-next-card prefetch shape as the consistency check
  // above, but for lib/reviewClozeVariation.ts's fresh-sentence generator —
  // independent concern (variety, not correctness), so a separate effect.
  useEffect(() => {
    const next = queue[index + 1];
    if (!next || clozeVariations[next.id]) return;
    let cancelled = false;
    void generateClozeVariation(next, next.language || settings.activeLanguage).then((variation) => {
      if (cancelled || !variation) return;
      setClozeVariations((prev) => ({ ...prev, [next.id]: variation }));
    });
    return () => {
      cancelled = true;
    };
  }, [index, queue[index + 1]?.id, settings.activeLanguage]);

  async function check() {
    if (!current || result || checking) return;
    // Measured before the (possibly slow) LLM pass so its latency never
    // penalizes the learner's speed-based grade.
    const elapsed = performance.now() - shownAtRef.current;
    let judgement = judgeAnswer(typedAnswer, current.front);
    let llmAccepted = false;
    let llmNote = "";
    const reviewConn = connection ? connectionForTask("correction") : null;
    if (judgement === "wrong" && typedAnswer.trim() && reviewConn) {
      setChecking(true);
      try {
        const verdict = await judgeReviewAnswer({
          connection: reviewConn,
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
        if (verdict.verdict === "correct") {
          judgement = "correct";
          llmAccepted = true;
        } else if (verdict.verdict === "near") {
          judgement = "near";
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
    // Interleaving: a genuine miss also reappears later in *this session's*
    // queue (independent of its persisted SRS reschedule, which still moves
    // it to tomorrow-or-later) so the learner gets another shot at it today
    // instead of only via the app's normal daily due-date cycle.
    if (judgement === "wrong") {
      const missedCard = current;
      setQueue((prev) => {
        const insertAt = Math.min(prev.length, index + 1 + REQUEUE_OFFSET);
        const next = [...prev];
        next.splice(insertAt, 0, missedCard);
        return next;
      });
    }
    setDoneCount((n) => n + 1);
    setResult({ judgement, days, llmAccepted, llmNote });
  }

  function next() {
    setIndex((i) => i + 1);
    setResult(null);
    setTypedAnswer("");
    setExampleTranslationRevealed(false);
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
                <p class="review-prompt">{displayCloze}</p>
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
                    <CardFront front={current.front} reading={current.reading} language={cardLanguage} readingClassName="review-answer-reading" />
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
                    <div class="review-answer-example">
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
                      {current.exampleSentenceTranslation && (
                        <button
                          type="button"
                          class="link-button example-translation-toggle"
                          aria-expanded={exampleTranslationRevealed}
                          onClick={() => setExampleTranslationRevealed((v) => !v)}
                        >
                          {exampleTranslationRevealed ? t("cards-example-translation-hide") : t("cards-example-translation-show")}
                        </button>
                      )}
                      {exampleTranslationRevealed && <p class="example-translation">{current.exampleSentenceTranslation}</p>}
                    </div>
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
