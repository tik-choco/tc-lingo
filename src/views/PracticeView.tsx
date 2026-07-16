// The daily core loop: pick a topic, produce output, get structured AI
// feedback (原文/修正版/理由/再回答問題), retry in place, and optionally turn
// mistakes into review cards. Same-topic repetition (round 1/2/3) is driven
// entirely by lib/topics.ts's nextRoundFor.
import { useEffect, useState } from "preact/hooks";
import { Sparkles } from "lucide-preact";
import { addAttempt, addTopic, attemptsForTopic, loadTopics, nextRoundFor, subscribeTopics, updateAttempt } from "../lib/topics";
import type { AttemptRound, PracticeAttempt, Topic } from "../types";
import { addCard } from "../lib/cards";
import { loadSettings } from "../lib/settings";
import { useLlmPreset } from "../hooks/useLlmPreset";
import { planTopicFanOut, requestFeedback, requestMistakeCards, requestTopicSuggestion } from "../lib/llm";
import type { CardCandidate, FeedbackResult } from "../lib/parse";
import { FeedbackPanel } from "../components/FeedbackPanel";
import { MistakeCardPicker } from "../components/MistakeCardPicker";
import { t } from "../i18n";
import { languageDisplayName } from "../lib/languages";

function roundLabel(round: AttemptRound): string {
  return t(`practice-round-${round}`);
}

export function PracticeView() {
  const { target } = useLlmPreset();
  const settings = loadSettings();

  const [topics, setTopics] = useState<Topic[]>(() => loadTopics(settings.activeLanguage));
  const [activeTopicId, setActiveTopicId] = useState<string | null>(() => loadTopics(settings.activeLanguage)[0]?.id ?? null);
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
  const [showPrevious, setShowPrevious] = useState(false);
  const [candidates, setCandidates] = useState<CardCandidate[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [cardsAdded, setCardsAdded] = useState(0);
  const [error, setError] = useState("");

  function resetForNewTopic() {
    setActiveTopicId(null);
    setText("");
    setCurrentAttempt(null);
    setRetryAnswer("");
    setCandidates(null);
    setCardsAdded(0);
    setShowPrevious(false);
    setError("");
    setBatchGeneratedCount(0);
  }

  function resetForNextRound() {
    setText("");
    setCurrentAttempt(null);
    setRetryAnswer("");
    setCandidates(null);
    setCardsAdded(0);
    setShowPrevious(false);
    setError("");
    setBatchGeneratedCount(0);
  }

  async function generateTopic() {
    if (!target) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setGeneratingTopic(true);
    try {
      const suggestion = await requestTopicSuggestion({
        target,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        recentTitles: topics.slice(0, 10).map((topic) => topic.title),
      });
      const topic = addTopic({ title: suggestion.title, prompt: suggestion.prompt, custom: false, language: settings.activeLanguage });
      setActiveTopicId(topic.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("practice-topic-generate-failed"));
    } finally {
      setGeneratingTopic(false);
    }
  }

  async function generateAllTopics() {
    if (!target) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setGeneratingAllTopics(true);
    try {
      const plan = await planTopicFanOut({
        target,
        nativeLanguage: settings.nativeLanguage,
        candidateLanguages: settings.targetLanguages,
        recentTitlesByLanguage: Object.fromEntries(
          settings.targetLanguages.map((lang) => [lang, loadTopics(lang).slice(0, 10).map((t) => t.title)]),
        ),
      });
      const created = await Promise.all(
        plan.targets.map(async (lang) => {
          const suggestion = await requestTopicSuggestion({
            target,
            targetLanguage: lang,
            nativeLanguage: settings.nativeLanguage,
            recentTitles: loadTopics(lang).slice(0, 10).map((t) => t.title),
            theme: plan.theme,
          });
          return addTopic({ title: suggestion.title, prompt: suggestion.prompt, custom: false, language: lang });
        }),
      );
      setTopics(loadTopics(settings.activeLanguage));
      const preferred = created.find((t) => t.language === settings.activeLanguage) ?? created[0];
      if (preferred) setActiveTopicId(preferred.id);
      setBatchGeneratedCount(plan.targets.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("practice-topic-generate-failed"));
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
    if (!target) {
      setError(t("practice-need-llm"));
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const feedback: FeedbackResult = await requestFeedback({
        target,
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
        reasons: feedback.reasons,
        retryPrompt: feedback.retryPrompt,
      });
      setCurrentAttempt(attempt);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("practice-feedback-failed"));
    } finally {
      setSubmitting(false);
    }
  }

  function saveRetryAnswer() {
    if (!currentAttempt) return;
    updateAttempt(currentAttempt.id, { retryAnswer });
  }

  async function extractCards() {
    if (!currentAttempt || !target) return;
    setError("");
    setExtracting(true);
    try {
      const found = await requestMistakeCards({
        target,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: currentAttempt.original,
        corrected: currentAttempt.corrected,
        reasons: currentAttempt.reasons,
      });
      setCandidates(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("practice-extract-failed"));
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
          <h2>{t("practice-choose-topic-heading")}</h2>
          <p class="hint-text">{t("practice-choose-topic-hint")}</p>
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
              {topics.slice(0, 8).map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => setActiveTopicId(t.id)}>
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  if (round === null) {
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
          <span class="round-badge">{roundLabel(round)}</span>
        </div>
        <p class="topic-prompt">{activeTopic.prompt}</p>
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
                reasons={previousAttempt.reasons}
                retryPrompt={previousAttempt.retryPrompt}
              />
            )}
          </div>
        )}

        {!currentAttempt ? (
          <form onSubmit={submitAttempt}>
            <textarea
              class="practice-textarea"
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              rows={6}
              placeholder={t("practice-write-placeholder", { language: languageDisplayName(settings.activeLanguage) })}
            />
            <div class="button-row">
              <button type="submit" class="primary-button" disabled={submitting || !text.trim()}>
                {submitting ? t("practice-submitting") : t("practice-request-feedback")}
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
              reasons={currentAttempt.reasons}
              retryPrompt={currentAttempt.retryPrompt}
            />

            {currentAttempt.retryPrompt && (
              <div class="feedback-field">
                <h3>{t("practice-retry-heading")}</h3>
                <textarea
                  class="practice-textarea"
                  value={retryAnswer}
                  onInput={(e) => setRetryAnswer((e.target as HTMLTextAreaElement).value)}
                  onBlur={saveRetryAnswer}
                  rows={3}
                  placeholder={t("practice-retry-placeholder")}
                />
              </div>
            )}

            {candidates === null ? (
              <div class="button-row">
                <button type="button" onClick={extractCards} disabled={extracting}>
                  {extracting ? t("practice-extracting") : t("practice-extract-cards")}
                </button>
              </div>
            ) : candidates.length > 0 ? (
              <MistakeCardPicker candidates={candidates} onAdd={addSelectedCards} />
            ) : (
              <p class="hint-text">{t("practice-no-cards-found")}</p>
            )}
            {cardsAdded > 0 && <p class="hint-text status-ok">{t("practice-cards-added", { count: cardsAdded })}</p>}

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
