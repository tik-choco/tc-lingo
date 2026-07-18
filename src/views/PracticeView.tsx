// The daily core loop: pick a topic, produce output, get structured AI
// feedback (原文/修正版/理由/再回答問題), retry in place, and optionally turn
// mistakes into review cards. Same-topic repetition (round 1/2/3) is driven
// entirely by lib/topics.ts's nextRoundFor.
import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, Save, Sparkles, Square, Volume2 } from "lucide-preact";
import { addAttempt, addTopic, attemptsForTopic, loadTopics, nextRoundFor, subscribeTopics, updateAttempt } from "../lib/topics";
import type { AttemptRound, Card, PracticeAttempt, Topic } from "../types";
import { addCard, dueCards } from "../lib/cards";
import { changedCorrectedSentences, saveSentenceCards } from "../lib/sentenceCards";
import { autoExtractMistakeCards } from "../lib/autoExtract";
import { effectiveBand, levelInstruction, recordOutputSample, subscribeLevels } from "../lib/level";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { useSpeech } from "../hooks/useSpeech";
import { planTopicFanOut, requestFeedback, requestMistakeCards, requestRetryFeedback, requestTopicSuggestion } from "../lib/llm";
import { localizeNetworkError } from "../lib/network";
import type { CardCandidate, FeedbackResult } from "../lib/parse";
import { FeedbackPanel, RetryPromptField } from "../components/FeedbackPanel";
import { MistakeCardPicker } from "../components/MistakeCardPicker";
import { SpellingDrill } from "../components/SpellingDrill";
import { diffChars } from "../lib/diff";
import { correctedSentences, misspelledWords } from "../lib/spelling";
import { t } from "../i18n";
import { languageDisplayName } from "../lib/languages";

/** Up to this many due-for-review card fronts get woven into topic
 * generation as spaced re-use hints (see requestTopicSuggestion's
 * reviewWords param and CLAUDE.md's core loop diagram). */
const MAX_REVIEW_WORDS_FOR_TOPIC = 5;

/** Inline display for a retry-answer "check my answer" result: reuses the
 * same diff + reasons layout as FeedbackPanel's corrected field, but scoped
 * to just the retry exchange (no original/retryPrompt fields to repeat).
 * `language` drives its own read-aloud button (independent useSpeech
 * instance from FeedbackPanel's — this is a separate piece of text). */
function RetryCheckResult({
  retryAnswer,
  retryCorrected,
  retryCorrectedReading,
  retryReasons,
  language,
  showReadingAids,
}: {
  retryAnswer: string;
  retryCorrected: string;
  retryCorrectedReading: string;
  retryReasons: string;
  language: string;
  showReadingAids: boolean;
}) {
  const chunks = diffChars(retryAnswer, retryCorrected);
  const speech = useSpeech();
  const speakId = "retry-corrected";
  const speaking = speech.speakingId === speakId;
  const loading = speech.loadingId === speakId;
  return (
    <div class="feedback-field">
      <div class="topic-header">
        <h3>{t("practice-feedback-corrected")}</h3>
        {speech.supported && (
          <button
            type="button"
            class="speak-button"
            onClick={() => speech.speak(retryCorrected, language, speakId)}
            disabled={loading}
            aria-pressed={speaking}
            aria-label={speaking ? t("practice-speak-corrected-stop") : t("practice-speak-corrected")}
            title={speaking ? t("practice-speak-corrected-stop") : t("practice-speak-corrected")}
          >
            {loading ? <Loader2 size={14} class="speak-button-spin" /> : speaking ? <Square size={14} /> : <Volume2 size={14} />}
          </button>
        )}
      </div>
      <p class="feedback-diff">
        {chunks.map((chunk, i) => (
          <span key={i} class={chunk.op === "same" ? undefined : `diff-${chunk.op}`}>
            {chunk.op === "removed" ? null : chunk.text}
          </span>
        ))}
      </p>
      {showReadingAids && retryCorrectedReading && <p class="reading-aid">{retryCorrectedReading}</p>}
      {retryReasons && (
        <>
          <h3>{t("practice-feedback-reasons")}</h3>
          <p class="feedback-reasons">{retryReasons}</p>
        </>
      )}
      {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
    </div>
  );
}

function roundLabel(round: AttemptRound): string {
  return t(`practice-round-${round}`);
}

export function PracticeView() {
  const { connection } = useLlmConnection();
  const speech = useSpeech();
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  /** Estimated CEFR band for the active language, "" while unknown (see
   * lib/level.ts) — shown as a small chip so the learner sees what
   * difficulty topic suggestions and feedback will target. */
  const [levelBand, setLevelBand] = useState(() => effectiveBand(settings.activeLanguage));
  useEffect(() => subscribeLevels(() => setLevelBand(effectiveBand(loadSettings().activeLanguage))), []);
  useEffect(() => setLevelBand(effectiveBand(settings.activeLanguage)), [settings.activeLanguage]);

  const [topics, setTopics] = useState<Topic[]>(() => loadTopics(settings.activeLanguage));
  // Deliberately starts on the topic chooser instead of auto-resuming the
  // newest topic: being dropped back into the same topic on every visit reads
  // as repetition fatigue. Rounds 2/3 stay one tap away via the past-topics
  // list's resume badges below — repetition is offered, not forced.
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<PracticeAttempt[]>(() =>
    activeTopicId ? attemptsForTopic(activeTopicId) : [],
  );

  useEffect(
    () =>
      subscribeTopics(() => {
        setTopics(loadTopics(loadSettings().activeLanguage));
        if (activeTopicId) setAttempts(attemptsForTopic(activeTopicId));
      }),
    [activeTopicId],
  );

  useEffect(() => {
    setAttempts(activeTopicId ? attemptsForTopic(activeTopicId) : []);
  }, [activeTopicId]);

  const activeTopic = topics.find((t) => t.id === activeTopicId) ?? null;
  const round = activeTopicId ? nextRoundFor(activeTopicId) : null;
  const previousAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

  const [topicRequest, setTopicRequest] = useState("");
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customTitle, setCustomTitle] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [generatingTopic, setGeneratingTopic] = useState(false);
  const [generatingAllTopics, setGeneratingAllTopics] = useState(false);
  const [batchGeneratedCount, setBatchGeneratedCount] = useState(0);

  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [currentAttempt, setCurrentAttempt] = useState<PracticeAttempt | null>(null);
  const [retryAnswer, setRetryAnswer] = useState("");
  const [checkingRetry, setCheckingRetry] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);
  const [candidates, setCandidates] = useState<CardCandidate[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [cardsAdded, setCardsAdded] = useState(0);
  // Background auto-extraction results (lib/autoExtract.ts), shown as a small
  // notice in place of the manual "extract cards" flow when
  // settings.autoExtractCards is on — see submitAttempt/checkRetryAnswer.
  const [autoAddedCards, setAutoAddedCards] = useState<Card[]>([]);
  const [autoAddedRetryCards, setAutoAddedRetryCards] = useState<Card[]>([]);
  // "Save corrected sentences as SRS cards" button state, kept separately for
  // the main feedback vs. the retry-check result (see saveSentenceCards*
  // below) — reset alongside the rest of the attempt state whenever a new
  // round/topic starts.
  const [savingSentenceCards, setSavingSentenceCards] = useState(false);
  const [sentenceCardsSaved, setSentenceCardsSaved] = useState(false);
  const [sentenceCardsSavedCount, setSentenceCardsSavedCount] = useState(0);
  const [savingRetrySentenceCards, setSavingRetrySentenceCards] = useState(false);
  const [retrySentenceCardsSaved, setRetrySentenceCardsSaved] = useState(false);
  const [retrySentenceCardsSavedCount, setRetrySentenceCardsSavedCount] = useState(0);
  const [error, setError] = useState("");

  // Kept in sync with the latest retryAnswer/currentAttempt so the unmount
  // cleanup below can flush the retry answer to storage even though effect
  // cleanups only see the closure from when the effect last ran (see #2 in
  // the task: onBlur alone can lose the answer if the view unmounts first).
  const retryAnswerRef = useRef(retryAnswer);
  const currentAttemptRef = useRef(currentAttempt);
  useEffect(() => {
    retryAnswerRef.current = retryAnswer;
  }, [retryAnswer]);
  useEffect(() => {
    currentAttemptRef.current = currentAttempt;
  }, [currentAttempt]);
  useEffect(
    () => () => {
      const attempt = currentAttemptRef.current;
      if (attempt) updateAttempt(attempt.id, { retryAnswer: retryAnswerRef.current });
    },
    [],
  );

  function flushRetryAnswer() {
    if (currentAttempt) updateAttempt(currentAttempt.id, { retryAnswer });
  }

  // Keyboard-only flow: focus the answer textarea the moment a fresh, empty
  // prompt appears (topic freshly chosen, or a new round started via
  // resetForNextRound) — but not on unrelated re-renders where the form was
  // already visible and the learner may have moved focus elsewhere.
  const answerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const showingAnswerForm = activeTopic !== null && round !== null && currentAttempt === null;
  useEffect(() => {
    if (showingAnswerForm) answerTextareaRef.current?.focus();
  }, [showingAnswerForm, activeTopicId, round]);

  // Once feedback arrives and a retry follow-up is offered, move focus there
  // too so the learner can go from reading the correction straight into the
  // retry without reaching for the mouse.
  const retryTextareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (currentAttempt?.retryPrompt) retryTextareaRef.current?.focus();
  }, [currentAttempt?.id]);

  function resetForNewTopic() {
    flushRetryAnswer();
    setActiveTopicId(null);
    setText("");
    setCurrentAttempt(null);
    setRetryAnswer("");
    setCheckingRetry(false);
    setCandidates(null);
    setCardsAdded(0);
    setAutoAddedCards([]);
    setAutoAddedRetryCards([]);
    setSavingSentenceCards(false);
    setSentenceCardsSaved(false);
    setSentenceCardsSavedCount(0);
    setSavingRetrySentenceCards(false);
    setRetrySentenceCardsSaved(false);
    setRetrySentenceCardsSavedCount(0);
    setShowPrevious(false);
    setError("");
    setBatchGeneratedCount(0);
  }

  function resetForNextRound() {
    flushRetryAnswer();
    setText("");
    setCurrentAttempt(null);
    setRetryAnswer("");
    setCheckingRetry(false);
    setCandidates(null);
    setCardsAdded(0);
    setAutoAddedCards([]);
    setAutoAddedRetryCards([]);
    setSavingSentenceCards(false);
    setSentenceCardsSaved(false);
    setSentenceCardsSavedCount(0);
    setSavingRetrySentenceCards(false);
    setRetrySentenceCardsSaved(false);
    setRetrySentenceCardsSavedCount(0);
    setShowPrevious(false);
    setError("");
    setBatchGeneratedCount(0);
  }

  async function generateTopic() {
    if (!connection) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setGeneratingTopic(true);
    try {
      const suggestion = await requestTopicSuggestion({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        recentTitles: topics.slice(0, 10).map((topic) => topic.title),
        reviewWords: dueCards(new Date(), settings.activeLanguage)
          .slice(0, MAX_REVIEW_WORDS_FOR_TOPIC)
          .map((c) => c.front),
        topicRequest: topicRequest.trim() || undefined,
        levelHint: levelInstruction(settings.activeLanguage),
      });
      const topic = addTopic({ title: suggestion.title, prompt: suggestion.prompt, custom: false, language: settings.activeLanguage });
      setActiveTopicId(topic.id);
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-topic-generate-failed")));
    } finally {
      setGeneratingTopic(false);
    }
  }

  async function generateAllTopics() {
    if (!connection) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setGeneratingAllTopics(true);
    try {
      const plan = await planTopicFanOut({
        connection,
        nativeLanguage: settings.nativeLanguage,
        candidateLanguages: settings.targetLanguages,
        recentTitlesByLanguage: Object.fromEntries(
          settings.targetLanguages.map((lang) => [lang, loadTopics(lang).slice(0, 10).map((t) => t.title)]),
        ),
        topicRequest: topicRequest.trim() || undefined,
      });
      const created = await Promise.all(
        plan.targets.map(async (lang) => {
          const suggestion = await requestTopicSuggestion({
            connection,
            targetLanguage: lang,
            nativeLanguage: settings.nativeLanguage,
            recentTitles: loadTopics(lang).slice(0, 10).map((t) => t.title),
            theme: plan.theme,
            reviewWords: dueCards(new Date(), lang)
              .slice(0, MAX_REVIEW_WORDS_FOR_TOPIC)
              .map((c) => c.front),
            topicRequest: topicRequest.trim() || undefined,
            levelHint: levelInstruction(lang),
          });
          return addTopic({ title: suggestion.title, prompt: suggestion.prompt, custom: false, language: lang });
        }),
      );
      setTopics(loadTopics(settings.activeLanguage));
      const preferred = created.find((t) => t.language === settings.activeLanguage) ?? created[0];
      if (preferred) setActiveTopicId(preferred.id);
      setBatchGeneratedCount(plan.targets.length);
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-topic-generate-failed")));
    } finally {
      setGeneratingAllTopics(false);
    }
  }

  function addCustomTopic(event: Event) {
    event.preventDefault();
    if (!customTitle.trim() || !customPrompt.trim()) return;
    const topic = addTopic({ title: customTitle, prompt: customPrompt, custom: true, language: settings.activeLanguage });
    setActiveTopicId(topic.id);
    setShowCustomForm(false);
    setCustomTitle("");
    setCustomPrompt("");
  }

  async function submitAttempt(event: Event) {
    event.preventDefault();
    if (!activeTopic || round === null || !text.trim()) return;
    if (!connection) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setAutoAddedCards([]);
    setSubmitting(true);
    try {
      const feedback: FeedbackResult = await requestFeedback({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        topicPrompt: activeTopic.prompt,
        userText: text,
      });
      const attempt = addAttempt({
        topicId: activeTopic.id,
        round,
        original: text,
        corrected: feedback.corrected,
        correctedReading: feedback.correctedReading,
        reasons: feedback.reasons,
        retryPrompt: feedback.retryPrompt,
        retryPromptReading: feedback.retryPromptReading,
      });
      setCurrentAttempt(attempt);
      recordOutputSample(settings.activeLanguage, text, feedback.corrected);
      // Fire-and-forget: never blocks feedback rendering. Gates on
      // settings.autoExtractCards itself, so it's safe to always call.
      autoExtractMistakeCards({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: text,
        corrected: feedback.corrected,
        reasons: feedback.reasons,
        sourceTopicId: activeTopic.id,
      }).then((added) => {
        if (added.length > 0) setAutoAddedCards(added);
      });
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-feedback-failed")));
    } finally {
      setSubmitting(false);
    }
  }

  function saveRetryAnswer() {
    flushRetryAnswer();
  }

  async function checkRetryAnswer() {
    if (!currentAttempt || !retryAnswer.trim()) return;
    if (!connection) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setAutoAddedRetryCards([]);
    setCheckingRetry(true);
    try {
      const result = await requestRetryFeedback({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        topicPrompt: activeTopic?.prompt ?? "",
        retryPrompt: currentAttempt.retryPrompt,
        retryAnswer,
      });
      updateAttempt(currentAttempt.id, {
        retryAnswer,
        retryCorrected: result.corrected,
        retryCorrectedReading: result.correctedReading,
        retryReasons: result.reasons,
      });
      setCurrentAttempt({
        ...currentAttempt,
        retryAnswer,
        retryCorrected: result.corrected,
        retryCorrectedReading: result.correctedReading,
        retryReasons: result.reasons,
      });
      recordOutputSample(settings.activeLanguage, retryAnswer, result.corrected);
      // Same fire-and-forget auto-extraction as submitAttempt, but only when
      // the retry actually needed a correction (a "" corrected means the
      // retry answer was already natural — nothing to extract).
      if (result.corrected.trim()) {
        autoExtractMistakeCards({
          connection,
          targetLanguage: settings.activeLanguage,
          nativeLanguage: settings.nativeLanguage,
          original: retryAnswer,
          corrected: result.corrected,
          reasons: result.reasons,
          sourceTopicId: activeTopic?.id ?? null,
        }).then((added) => {
          if (added.length > 0) setAutoAddedRetryCards(added);
        });
      }
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-retry-check-failed")));
    } finally {
      setCheckingRetry(false);
    }
  }

  // Saves the changed sentence(s) from the main feedback's original/corrected
  // pair as SRS sentence cards (see lib/sentenceCards.ts). Separate from the
  // mistake-word extraction flow below: this saves whole corrected sentences
  // (recalled from their translation in review), not word/meaning pairs.
  async function saveMainSentenceCards() {
    if (!currentAttempt || !activeTopic) return;
    if (!connection) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setSavingSentenceCards(true);
    try {
      const added = await saveSentenceCards({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: currentAttempt.original,
        corrected: currentAttempt.corrected,
        sourceTopicId: activeTopic.id,
      });
      setSentenceCardsSaved(true);
      setSentenceCardsSavedCount(added.length);
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-save-sentence-failed")));
    } finally {
      setSavingSentenceCards(false);
    }
  }

  // Same as saveMainSentenceCards but scoped to the retry-check exchange
  // (retryAnswer/retryCorrected) — kept as separate state so the two buttons
  // save/disable independently.
  async function saveRetrySentenceCards() {
    if (!currentAttempt?.retryCorrected) return;
    if (!connection) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setSavingRetrySentenceCards(true);
    try {
      const added = await saveSentenceCards({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: currentAttempt.retryAnswer,
        corrected: currentAttempt.retryCorrected,
        sourceTopicId: activeTopic?.id ?? null,
      });
      setRetrySentenceCardsSaved(true);
      setRetrySentenceCardsSavedCount(added.length);
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-save-sentence-failed")));
    } finally {
      setSavingRetrySentenceCards(false);
    }
  }

  async function extractCards() {
    if (!currentAttempt || !connection) return;
    setError("");
    setExtracting(true);
    try {
      const found = await requestMistakeCards({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: currentAttempt.original,
        corrected: currentAttempt.corrected,
        reasons: currentAttempt.reasons,
      });
      setCandidates(found);
    } catch (e) {
      setError(localizeNetworkError(e, t("practice-extract-failed")));
    } finally {
      setExtracting(false);
    }
  }

  function addSelectedCards(selected: CardCandidate[]) {
    if (!activeTopic) return;
    for (const c of selected) {
      addCard({ ...c, source: "mistake", sourceTopicId: activeTopic.id, language: activeTopic.language });
    }
    setCardsAdded(selected.length);
    setCandidates(null);
  }

  if (!activeTopic) {
    return (
      <div class="view-container practice-view">
        <section class="card-panel">
          <div class="topic-header">
            <h2>{t("practice-choose-topic-heading")}</h2>
            {levelBand && (
              <span class="language-badge practice-level-badge">{t("practice-level-badge", { band: levelBand })}</span>
            )}
          </div>
          <p class="hint-text">{t("practice-choose-topic-hint")}</p>
          <p class="hint-text">{t("practice-level-hint")}</p>
          <div class="field-grid">
            <label>
              {t("practice-topic-request-label")}
              <input
                type="text"
                value={topicRequest}
                onInput={(e) => setTopicRequest((e.target as HTMLInputElement).value)}
                placeholder={t("practice-topic-request-placeholder")}
              />
            </label>
          </div>
          <div class="button-row">
            <button type="button" class="primary-button" onClick={generateTopic} disabled={generatingTopic}>
              <Sparkles size={16} />
              {generatingTopic ? t("practice-generating") : t("practice-suggest-topic")}
            </button>
            {settings.targetLanguages.length > 1 && (
              <button type="button" onClick={generateAllTopics} disabled={generatingAllTopics || generatingTopic}>
                {generatingAllTopics ? t("practice-generating") : t("practice-generate-all-topics")}
              </button>
            )}
            <button type="button" onClick={() => setShowCustomForm((v) => !v)}>
              {t("practice-enter-custom-topic")}
            </button>
          </div>
          {showCustomForm && (
            <form class="field-grid" onSubmit={addCustomTopic}>
              <label>
                {t("practice-custom-title-label")}
                <input type="text" value={customTitle} onInput={(e) => setCustomTitle((e.target as HTMLInputElement).value)} />
              </label>
              <label>
                {t("practice-custom-prompt-label")}
                <textarea value={customPrompt} onInput={(e) => setCustomPrompt((e.target as HTMLTextAreaElement).value)} rows={3} />
              </label>
              <button type="submit" class="primary-button">
                {t("practice-start-with-topic")}
              </button>
            </form>
          )}
          {error && <p class="error-text">{error}</p>}
        </section>

        {topics.length > 0 && (
          <section class="card-panel">
            <h2>{t("practice-past-topics-heading")}</h2>
            <ul class="topic-pick-list">
              {topics.slice(0, 8).map((topic) => {
                // In-progress topics (some attempts recorded, rounds left)
                // get a resume badge so continuing is an offer, not a default.
                const resumeRound = attemptsForTopic(topic.id).length > 0 ? nextRoundFor(topic.id) : null;
                return (
                  <li key={topic.id}>
                    <button type="button" onClick={() => setActiveTopicId(topic.id)}>
                      {topic.title}
                      {resumeRound !== null && (
                        <span class="topic-resume-badge">
                          {t("practice-topic-resume-badge", { round: roundLabel(resumeRound) })}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    );
  }

  // Read-aloud target language for this topic's feedback text: the topic's
  // own language, falling back to the active study language for topics
  // saved before multi-language support existed (see types.ts Topic).
  const feedbackLanguage = activeTopic.language || settings.activeLanguage;

  // Round 3's submission makes nextRoundFor return null on the very next
  // render — keep showing the just-received feedback (currentAttempt) and
  // only switch to the all-done screen once nothing is being displayed.
  if (round === null && !currentAttempt) {
    return (
      <div class="view-container practice-view">
        <section class="card-panel">
          <h2>{activeTopic.title}</h2>
          <p class="hint-text status-ok">{t("practice-all-rounds-done-hint")}</p>
          <button type="button" class="primary-button" onClick={resetForNewTopic}>
            {t("practice-start-new-topic")}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div class="view-container practice-view">
      <section class="card-panel">
        <div class="topic-header">
          <h2>{activeTopic.title}</h2>
          <span class="topic-header-badges">
            {(currentAttempt !== null || round !== null) && (
              <span class="round-badge">{roundLabel(currentAttempt ? currentAttempt.round : (round as AttemptRound))}</span>
            )}
            {levelBand && (
              <span class="language-badge practice-level-badge">{t("practice-level-badge", { band: levelBand })}</span>
            )}
          </span>
        </div>
        <p class="topic-prompt">
          {activeTopic.prompt}
          {speech.supported && (
            <button
              type="button"
              class="speak-button"
              onClick={() => speech.speak(activeTopic.prompt, feedbackLanguage, `${activeTopic.id}:prompt`)}
              disabled={speech.loadingId === `${activeTopic.id}:prompt`}
              aria-pressed={speech.speakingId === `${activeTopic.id}:prompt`}
              aria-label={
                speech.speakingId === `${activeTopic.id}:prompt` ? t("practice-speak-topic-stop") : t("practice-speak-topic")
              }
              title={speech.speakingId === `${activeTopic.id}:prompt` ? t("practice-speak-topic-stop") : t("practice-speak-topic")}
            >
              {speech.loadingId === `${activeTopic.id}:prompt` ? (
                <Loader2 size={14} class="speak-button-spin" />
              ) : speech.speakingId === `${activeTopic.id}:prompt` ? (
                <Square size={14} />
              ) : (
                <Volume2 size={14} />
              )}
            </button>
          )}
        </p>
        {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
        {batchGeneratedCount > 0 && (
          <p class="hint-text status-ok">{t("practice-batch-generated", { count: batchGeneratedCount })}</p>
        )}

        {previousAttempt && (
          <div class="previous-attempt">
            <button type="button" class="link-button" onClick={() => setShowPrevious((v) => !v)}>
              {showPrevious ? t("practice-hide-previous") : t("practice-show-previous")}
            </button>
            {showPrevious && (
              <FeedbackPanel
                original={previousAttempt.original}
                corrected={previousAttempt.corrected}
                correctedReading={previousAttempt.correctedReading}
                reasons={previousAttempt.reasons}
                retryPrompt={previousAttempt.retryPrompt}
                retryPromptReading={previousAttempt.retryPromptReading}
                language={feedbackLanguage}
              />
            )}
          </div>
        )}

        {!currentAttempt ? (
          <form onSubmit={submitAttempt}>
            <textarea
              ref={answerTextareaRef}
              class="practice-textarea"
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !submitting && text.trim()) {
                  e.preventDefault();
                  submitAttempt(e);
                }
              }}
              rows={6}
              placeholder={t("practice-write-placeholder", { language: languageDisplayName(settings.activeLanguage) })}
            />
            <div class="button-row">
              <button type="submit" class="primary-button" disabled={submitting || !text.trim()}>
                {submitting ? (
                  t("practice-submitting")
                ) : (
                  <>
                    {t("practice-request-feedback")} <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Enter</kbd>
                  </>
                )}
              </button>
              <button type="button" onClick={resetForNewTopic}>
                {t("practice-different-topic")}
              </button>
            </div>
            {error && <p class="error-text">{error}</p>}
          </form>
        ) : (
          <>
            <FeedbackPanel
              original={currentAttempt.original}
              corrected={currentAttempt.corrected}
              correctedReading={currentAttempt.correctedReading}
              reasons={currentAttempt.reasons}
              retryPrompt={currentAttempt.retryPrompt}
              retryPromptReading={currentAttempt.retryPromptReading}
              language={feedbackLanguage}
              showRetryPrompt={false}
            />

            {currentAttempt.retryPrompt && (
              <div class="retry-block">
                <RetryPromptField
                  retryPrompt={currentAttempt.retryPrompt}
                  retryPromptReading={currentAttempt.retryPromptReading}
                  language={feedbackLanguage}
                />
                <textarea
                  ref={retryTextareaRef}
                  class="practice-textarea"
                  value={retryAnswer}
                  onInput={(e) => setRetryAnswer((e.target as HTMLTextAreaElement).value)}
                  onBlur={saveRetryAnswer}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !checkingRetry && retryAnswer.trim() && connection) {
                      e.preventDefault();
                      checkRetryAnswer();
                    }
                  }}
                  rows={3}
                  placeholder={t("practice-retry-placeholder")}
                />
                <div class="button-row">
                  <button type="button" onClick={checkRetryAnswer} disabled={checkingRetry || !retryAnswer.trim() || !connection}>
                    {checkingRetry ? (
                      t("practice-retry-checking")
                    ) : (
                      <>
                        {t("practice-retry-check")} <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Enter</kbd>
                      </>
                    )}
                  </button>
                </div>
                {currentAttempt.retryCorrected && (
                  <>
                    <RetryCheckResult
                      retryAnswer={currentAttempt.retryAnswer}
                      retryCorrected={currentAttempt.retryCorrected}
                      retryCorrectedReading={currentAttempt.retryCorrectedReading}
                      retryReasons={currentAttempt.retryReasons}
                      language={feedbackLanguage}
                      showReadingAids={settings.showReadingAids}
                    />
                    <SpellingDrill
                      key={`${currentAttempt.id}:retry`}
                      words={misspelledWords(currentAttempt.retryAnswer, currentAttempt.retryCorrected)}
                      sentences={correctedSentences(currentAttempt.retryAnswer, currentAttempt.retryCorrected)}
                    />
                    {changedCorrectedSentences(currentAttempt.retryAnswer, currentAttempt.retryCorrected).length > 0 &&
                      (!retrySentenceCardsSaved ? (
                        <div class="button-row">
                          <button type="button" onClick={saveRetrySentenceCards} disabled={savingRetrySentenceCards}>
                            <Save size={16} />
                            {savingRetrySentenceCards
                              ? t("practice-saving-sentence-cards")
                              : t("practice-save-sentence-cards")}
                          </button>
                        </div>
                      ) : (
                        <p class={retrySentenceCardsSavedCount > 0 ? "hint-text status-ok" : "hint-text"}>
                          {retrySentenceCardsSavedCount > 0
                            ? t("practice-sentence-cards-saved", { count: retrySentenceCardsSavedCount })
                            : t("practice-sentence-cards-duplicate")}
                        </p>
                      ))}
                  </>
                )}
                {autoAddedRetryCards.length > 0 && (
                  <p class="hint-text status-ok">
                    {t("practice-auto-cards-added", {
                      count: autoAddedRetryCards.length,
                      fronts: autoAddedRetryCards.map((c) => c.front).join(", "),
                    })}
                  </p>
                )}
              </div>
            )}

            {autoAddedCards.length > 0 && (
              <p class="hint-text status-ok">
                {t("practice-auto-cards-added", {
                  count: autoAddedCards.length,
                  fronts: autoAddedCards.map((c) => c.front).join(", "),
                })}
              </p>
            )}

            <SpellingDrill
              key={currentAttempt.id}
              words={misspelledWords(currentAttempt.original, currentAttempt.corrected)}
              sentences={correctedSentences(currentAttempt.original, currentAttempt.corrected)}
            />

            {changedCorrectedSentences(currentAttempt.original, currentAttempt.corrected).length > 0 &&
              (!sentenceCardsSaved ? (
                <div class="button-row">
                  <button type="button" onClick={saveMainSentenceCards} disabled={savingSentenceCards}>
                    <Save size={16} />
                    {savingSentenceCards ? t("practice-saving-sentence-cards") : t("practice-save-sentence-cards")}
                  </button>
                </div>
              ) : (
                <p class={sentenceCardsSavedCount > 0 ? "hint-text status-ok" : "hint-text"}>
                  {sentenceCardsSavedCount > 0
                    ? t("practice-sentence-cards-saved", { count: sentenceCardsSavedCount })
                    : t("practice-sentence-cards-duplicate")}
                </p>
              ))}

            {/* Manual extraction is the fallback for when auto-extraction
                (above) is off — see lib/autoExtract.ts / settings.autoExtractCards. */}
            {!settings.autoExtractCards && (
              <>
                {candidates === null ? (
                  <div class="button-row">
                    <button type="button" onClick={extractCards} disabled={extracting}>
                      {extracting ? t("practice-extracting") : t("practice-extract-cards")}
                    </button>
                  </div>
                ) : candidates.length > 0 ? (
                  <MistakeCardPicker candidates={candidates} onAdd={addSelectedCards} onClose={() => setCandidates(null)} />
                ) : (
                  <p class="hint-text">{t("practice-no-cards-found")}</p>
                )}
                {cardsAdded > 0 && <p class="hint-text status-ok">{t("practice-cards-added", { count: cardsAdded })}</p>}
              </>
            )}

            {error && <p class="error-text">{error}</p>}

            <div class="button-row">
              {nextRoundFor(activeTopic.id) !== null ? (
                <button type="button" class="primary-button" onClick={resetForNextRound}>
                  {t("practice-next-round")}
                </button>
              ) : (
                <p class="hint-text status-ok">{t("practice-all-rounds-complete")}</p>
              )}
              <button type="button" onClick={resetForNewTopic}>
                {t("practice-start-new-topic")}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
