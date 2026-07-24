// Retrieval practice: the review queue is snapshotted once when the view
// loads (not re-derived live from storage) so grading a card mid-session
// doesn't reshuffle the deck out from under the learner. "更新" re-snapshots
// on demand (e.g. after adding cards elsewhere).
//
// Grading is automatic: the learner types (or leaves blank) their recalled
// answer, "check" compares it and combines that with how long it took
// (autoGrade) to derive a ReviewGrade, which is applied via gradeCard
// immediately. There's no manual again/hard/good/easy choice. For a non-cloze
// card, "compares it" means judgeAnswer against `front` directly. For a cloze
// card, `front` stays the dictionary/base form (e.g. "manage to") but the
// blank in the sentence may grammatically need an inflected form (e.g.
// "managed to") — grading (lib/clozeFill.ts's judgeClozeAnswer) instead
// compares against `expectedFill`, the exact text derived to fill the
// DISPLAYED sentence's blank, with a typed answer matching `front` itself
// still earning "near" partial credit (lemmaMatch) since the learner clearly
// recalled the word. When an LLM connection exists, a non-blank answer that
// fails the strict check — or only earns a strict "near" that isn't the
// deterministic lemmaMatch case above — gets a second opinion
// (judgeReviewAnswer, passed the same displayed sentence/expectedFill):
// synonyms/equivalent phrasings count as correct, and a right-word-wrong-form
// slip (tense, plural, conjugation, ...) counts as "near" (partial credit)
// instead of lapsing the card outright — the verdict can only upgrade the
// strict judgement, never downgrade it. The learner put effort into the
// attempt either way, so the same pass also asks for a constructive
// `rewrite` — the displayed sentence with the LEARNER's own typed expression
// made to fit (inflection/collocation/word order corrected as needed),
// same spirit as the practice tab's corrected text — shown alongside the
// note whenever the model returns one.
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
//   (sentence + its own expected fill) for a card that's been seen before,
//   so repeat reviews don't always show the exact same sentence/answer (see
//   displayCloze/expectedFill).
import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, RotateCw, Square, Volume2 } from "lucide-preact";
import { dueCards, gradeCard } from "../lib/cards";
import { CardFront } from "../components/CardFront";
import { diffChars } from "../lib/diff";
import { GrammarExplain } from "../components/GrammarExplain";
import { SpellingDrill } from "../components/SpellingDrill";
import type { AnswerJudgement } from "../lib/srs";
import { autoGrade, judgeAnswer, scheduleReview } from "../lib/srs";
import { deriveClozeGaps, judgeClozeAnswer, stripEllipsisTokens } from "../lib/clozeFill";
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

/** Whitespace word count for a piece of text — used both to size
 * expandClozeBlank's per-word blanks and to judge whether the cloze cue
 * (below) is too sparse to answer from. A CJK-ish fill/sentence with no
 * spaces has no internal word boundary to split on, so it counts as a
 * single "word" — deliberately coarse, not a real tokenizer. */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Above this many words, a single-blank cloze stops being useful to expand
 * per-word (see expandClozeBlank) — the fill is no longer a short phrase but
 * most of the sentence (e.g. "___ ___ ___ ___ ___ ___ there is the
 * traffic." for a 6-word fill), which both looks absurd rendered blank-by-
 * blank and is effectively unanswerable from the remaining cue. */
const MAX_EXPANDABLE_BLANK_WORDS = 4;

/** Expands a cloze's single "___" blank into one "___" per word of `fill`
 * (e.g. "___ ___" for a two-word fill like "managed to") so the number of
 * blanks visually hints at how many words are expected, without revealing
 * anything about the words themselves. Single-word fills (the common case)
 * are left as the one blank the cloze already has. Only applies when the
 * cloze has exactly one blank — a multi-blank cloze (discontinuous
 * expression, e.g. "I ___ have ___ questions") already has one blank per gap
 * by construction, so it's rendered as-is; per-word-expanding any one of
 * those blanks would misrepresent which gap needs how many words. A fill
 * longer than MAX_EXPANDABLE_BLANK_WORDS words is also left as the single
 * "___" as-is (expanding it would blank almost the whole sentence) —
 * `longFillWordCount` is then the fill's word count so the caller can show a
 * word-count hint instead; 0 whenever expansion applied normally (or didn't
 * apply because the cloze has zero/multiple blanks). */
function expandClozeBlank(cloze: string, fill: string): { cloze: string; longFillWordCount: number } {
  const blanks = cloze.match(/_{2,}/g);
  if (!blanks || blanks.length !== 1) return { cloze, longFillWordCount: 0 };
  const match = cloze.match(/_{2,}/);
  if (!match || match.index === undefined) return { cloze, longFillWordCount: 0 };
  const count = wordCount(fill);
  if (count <= 1) return { cloze, longFillWordCount: 0 };
  if (count > MAX_EXPANDABLE_BLANK_WORDS) return { cloze, longFillWordCount: count };
  const expanded = Array.from({ length: count }, () => "___").join(" ");
  return { cloze: cloze.slice(0, match.index) + expanded + cloze.slice(match.index + match[0].length), longFillWordCount: 0 };
}

/** Below this fill/displayed-sentence word-count ratio (or above
 * MIN_INSUFFICIENT_CUE_FILL_WORDS in absolute fill length), the cloze's cue
 * — everything left un-blanked — is considered enough to plausibly recall
 * the answer from. At or above it, the question-phase translation toggle
 * (see promptTranslationRevealed) auto-reveals instead of requiring the
 * learner to notice and open it themselves. */
const INSUFFICIENT_CUE_FILL_RATIO = 0.5;
const MIN_INSUFFICIENT_CUE_FILL_WORDS = 5;

export function ReviewView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const { connection } = useLlmConnection();

  const [queue, setQueue] = useState<Card[]>(() => dueCards(new Date(), settings.activeLanguage));
  const [index, setIndex] = useState(0);
  // llmNote/llmAccepted/llmRewrite come from the optional LLM second-opinion
  // pass in check(): the note is shown regardless of outcome (why an
  // alternative counts, what a wrong/near answer needs to change, or an
  // explanation of llmRewrite), llmAccepted marks a rescued/upgraded
  // judgement, llmRewrite is the displayed sentence rewritten to use the
  // learner's own typed expression correctly (constructive correction —
  // see llm.ts's judgeReviewAnswer) — "" when the model didn't return one.
  // lemmaMatch (cloze cards only) marks a strict-judged "near" where the
  // typed answer matched front (the dictionary/base form) rather than the
  // sentence-fitting expectedFill — see lib/clozeFill.ts's judgeClozeAnswer.
  const [result, setResult] = useState<{
    judgement: AnswerJudgement;
    days: number;
    llmAccepted: boolean;
    llmNote: string;
    llmRewrite: string;
    lemmaMatch: boolean;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  // Optional retrieval-practice typing: the learner can type their recalled
  // answer before checking, and it's compared (then char-diffed for display)
  // against `compareTarget` once checked — `front` for a non-cloze card,
  // `expectedFill` for a cloze card (see compareTarget below). Cleared
  // whenever the card changes.
  const [typedAnswer, setTypedAnswer] = useState("");
  // Ephemeral, session-only cloze variations (lib/reviewClozeVariation.ts),
  // keyed by card id — never persisted, see the prefetch effect below.
  const [clozeVariations, setClozeVariations] = useState<Record<string, { cloze: string; answer: string; translation: string }>>({});
  // Toggle-on-demand example-sentence translation, same idea as PracticeView's
  // promptTranslationRevealed — reset whenever the shown card changes.
  const [exampleTranslationRevealed, setExampleTranslationRevealed] = useState(false);
  // The learner's manual choice for the question-phase translation toggle of
  // the DISPLAYED cloze sentence — distinct from exampleTranslationRevealed
  // above, which is the post-answer reveal panel's own toggle for
  // current.exampleSentence. null = no manual choice yet, so the shown state
  // falls back to the derived insufficientCue default (see
  // promptTranslationRevealed below). Kept as an override rather than the
  // shown state itself so the default is recomputed on every render — a
  // reset-then-effect approach breaks when the "next" card has the same id
  // (refresh with nothing graded, or an immediate requeue in a short queue),
  // since an id-keyed effect never refires then.
  const [promptTranslationOverride, setPromptTranslationOverride] = useState<boolean | null>(null);

  function refresh() {
    setQueue(dueCards(new Date(), settings.activeLanguage));
    setIndex(0);
    setResult(null);
    setDoneCount(0);
    setTypedAnswer("");
    setClozeVariations({});
    setExampleTranslationRevealed(false);
    setPromptTranslationOverride(null);
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
    setPromptTranslationOverride(null);
    shownAtRef.current = performance.now();
  }, [settings.activeLanguage]);

  const current = queue[index] ?? null;
  const cardLanguage = current?.language || settings.activeLanguage;
  // Ephemeral variation (lib/reviewClozeVariation.ts) when one's ready for
  // this card, else the card's own stored cloze — never both/blended.
  const variation = current ? clozeVariations[current.id] : undefined;
  const displayCloze = current ? (variation?.cloze ?? current.cloze) : "";
  // The exact text that fills displayCloze's blank(s): the variation's own
  // (always single-blank) answer, or the card's own stored cloze's gaps —
  // one per blank, joined with a space, since that's the format the learner
  // was instructed to type for a multi-blank cloze (lib/clozeFill.ts's
  // deriveClozeGaps) — falling back to `front` if alignment fails (stale/
  // malformed card data) or there's no cloze at all. That fallback strips
  // any discontinuous-expression ellipsis notation ("not... any" ->
  // "not any") since `front` here stands in as a grading/drill/diff target,
  // not a display string — it must be something the learner could actually
  // type. This — not `front` — is what grading/diffing compares the typed
  // answer against for cloze cards, since front is only ever the
  // dictionary/base form and may not be what the blank(s) grammatically need.
  const clozeGaps = current ? deriveClozeGaps(current.exampleSentence, current.cloze) : null;
  const expectedFill = current ? (variation?.answer ?? (clozeGaps ? clozeGaps.join(" ") : null) ?? stripEllipsisTokens(current.front)) : "";
  const compareTarget = current ? (current.cloze ? expectedFill : current.front) : "";
  const displayBlankCount = (displayCloze.match(/_{2,}/g) || []).length;
  // Expanded (or capped) rendering of displayCloze's blank(s) — see
  // expandClozeBlank's doc comment for when each branch applies.
  const clozeDisplay = expandClozeBlank(displayCloze, expectedFill);
  // Translation of the DISPLAYED sentence (question phase, before checking):
  // the variation's own translation when a variation is showing (never the
  // card's own exampleSentenceTranslation, which describes a different
  // sentence), else the card's stored translation. "" when neither exists —
  // callers just don't render the toggle then.
  const promptTranslation = current ? (variation ? variation.translation : current.exampleSentenceTranslation) : "";
  // The full (unblanked) form of whatever sentence is on screen, used only to
  // size the insufficient-cue ratio below — reconstructed from the
  // variation's single blank (see lib/reviewClozeVariation.ts) when one's
  // showing, else the card's own exampleSentence directly.
  const displayedSentenceFull = current ? (variation ? variation.cloze.replace("___", variation.answer) : current.exampleSentence) : "";

  const speech = useSpeech();

  // Response-time measurement: reset whenever a fresh, unanswered card is
  // shown, so `check()` can measure how long the learner took to answer.
  const shownAtRef = useRef<number>(performance.now());

  useEffect(() => {
    shownAtRef.current = performance.now();
  }, [current?.id]);

  // Default-open the question-phase translation when the cloze's cue is too
  // sparse to plausibly answer from: the expected fill is long in absolute
  // terms, or it makes up most of the displayed sentence's words — see the
  // observed-in-the-wild "___ ___ ___ ___ ___ ___ there is the traffic."
  // case this guards against. Derived every render (a late-arriving
  // variation legitimately re-decides the default for its own sentence); the
  // learner's explicit toggle (promptTranslationOverride) always wins.
  const fillWords = wordCount(expectedFill);
  const totalWords = wordCount(displayedSentenceFull);
  const insufficientCue =
    !!current?.cloze &&
    (fillWords >= MIN_INSUFFICIENT_CUE_FILL_WORDS || (totalWords > 0 && fillWords / totalWords >= INSUFFICIENT_CUE_FILL_RATIO));
  const promptTranslationRevealed = promptTranslationOverride ?? insufficientCue;

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
    void generateClozeVariation(next, next.language || settings.activeLanguage, settings.nativeLanguage).then((variation) => {
      if (cancelled || !variation) return;
      setClozeVariations((prev) => ({ ...prev, [next.id]: variation }));
    });
    return () => {
      cancelled = true;
    };
  }, [index, queue[index + 1]?.id, settings.activeLanguage, settings.nativeLanguage]);

  async function check() {
    if (!current || result || checking) return;
    // Measured before the (possibly slow) LLM pass so its latency never
    // penalizes the learner's speed-based grade.
    const elapsed = performance.now() - shownAtRef.current;
    const isCloze = !!current.cloze;
    // Cloze cards grade against expectedFill (the sentence-fitting form),
    // not front — but a typed answer matching front instead (the learner
    // recalled the word, not this blank's inflected form) still earns
    // partial credit ("near"), flagged via lemmaMatch for the note below.
    // Non-cloze cards have no sentence to fit, so they still grade against
    // front directly.
    let judgement: AnswerJudgement;
    let lemmaMatch = false;
    if (isCloze) {
      const clozeResult = judgeClozeAnswer(typedAnswer, expectedFill, current.front);
      judgement = clozeResult.judgement;
      lemmaMatch = clozeResult.lemmaMatch;
    } else {
      judgement = judgeAnswer(typedAnswer, current.front);
    }
    let llmAccepted = false;
    let llmNote = "";
    let llmRewrite = "";
    const reviewConn = connection ? connectionForTask("correction") : null;
    // Ask for a second opinion on a strict "wrong", and also on a strict
    // "near" that ISN'T the deterministic lemmaMatch case (that one already
    // has its own note — see review-lemma-form-note below — and skipping the
    // LLM there keeps it snappy).
    const wantsLlmPass = typedAnswer.trim() && reviewConn && (judgement === "wrong" || (judgement === "near" && !lemmaMatch));
    if (wantsLlmPass && reviewConn) {
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
          },
          // The DISPLAYED sentence/fill, not the card's own stored cloze —
          // may differ when an ephemeral variation is showing (see
          // displayCloze/expectedFill above).
          displayedCloze: isCloze ? displayCloze : "",
          expectedAnswer: expectedFill,
          typedAnswer: typedAnswer.trim(),
        });
        llmNote = verdict.note;
        llmRewrite = verdict.rewrite;
        // The verdict can only upgrade the strict judgement (correct > near >
        // wrong), never downgrade it — a strict "near" starting point must
        // never regress to "wrong" just because the LLM pass agreed it wasn't
        // fully correct.
        const rank: Record<AnswerJudgement, number> = { wrong: 0, near: 1, correct: 2 };
        if (rank[verdict.verdict] > rank[judgement]) {
          judgement = verdict.verdict;
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
    setResult({ judgement, days, llmAccepted, llmNote, llmRewrite, lemmaMatch });
  }

  function next() {
    setIndex((i) => i + 1);
    setResult(null);
    setTypedAnswer("");
    setExampleTranslationRevealed(false);
    // Clears the manual toggle so the next shown card starts from its own
    // derived insufficientCue default — even when it's the same card again
    // (immediate requeue), which an id-keyed reset would miss.
    setPromptTranslationOverride(null);
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
                <p class="review-prompt">{clozeDisplay.cloze}</p>
                <p class="review-recall-instruction">
                  {t(displayBlankCount >= 2 ? "review-cloze-instruction-multi" : "review-cloze-instruction")}
                  {clozeDisplay.longFillWordCount > 0 && (
                    <span class="review-cloze-word-count">
                      {" "}
                      {t("review-cloze-word-count", { count: clozeDisplay.longFillWordCount })}
                    </span>
                  )}
                </p>
                <p class="review-prompt-hint">
                  <span class="review-hint-label">{t("review-hint-label")}</span> {current.meaning}
                </p>
                {promptTranslation && (
                  <>
                    <button
                      type="button"
                      class="link-button example-translation-toggle"
                      aria-expanded={promptTranslationRevealed}
                      onClick={() => setPromptTranslationOverride(!promptTranslationRevealed)}
                    >
                      {promptTranslationRevealed ? t("cards-example-translation-hide") : t("cards-example-translation-show")}
                    </button>
                    {promptTranslationRevealed && <p class="example-translation">{promptTranslation}</p>}
                  </>
                )}
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
                {result.llmRewrite && (
                  <p class="review-rewrite">
                    <span class="review-hint-label">{t("review-rewrite-label")}</span> {result.llmRewrite}
                  </p>
                )}
                {result.lemmaMatch && (
                  <p class="hint-text status-ok">{t("review-lemma-form-note", { fill: expectedFill })}</p>
                )}
                {typedAnswer.trim() && result.judgement !== "correct" && (
                  <div class="review-answer-compare">
                    <p class="review-answer-compare-label">{t("review-answer-your-answer")}</p>
                    <p class="feedback-diff">
                      {diffChars(typedAnswer.trim(), compareTarget).map((chunk, i) => (
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
                  {/* Compared against the ellipsis-stripped front so a
                      discontinuous expression ("not... any" vs gaps
                      "not any") doesn't show a redundant hint when the
                      fills aren't actually inflected. */}
                  {current.cloze && expectedFill.trim().toLowerCase() !== stripEllipsisTokens(current.front).toLowerCase() && (
                    <p class="review-answer-in-sentence">
                      <span class="review-hint-label">{t("review-answer-in-sentence")}</span> {expectedFill}
                    </p>
                  )}
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
                  ([...compareTarget].length <= 12 ? (
                    <SpellingDrill key={current.id} words={[{ attempted: typedAnswer.trim(), correct: compareTarget }]} />
                  ) : (
                    <SpellingDrill
                      key={current.id}
                      words={[]}
                      sentences={[{ attempted: typedAnswer.trim(), correct: compareTarget }]}
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
