// 読む tab: comprehensible-input reading passages, the インプット step of the
// core loop (comprehensible input → retrieval practice → output → feedback →
// spaced re-use, see CLAUDE.md). Self-contained like every other view — no
// props, reads the store directly.
import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, Sparkles, Square, Volume2 } from "lucide-preact";
import { deletePassage, loadPassages, requestReadingPassage, subscribePassages } from "../lib/reading";
import type { ReadingPassage } from "../types";
import { addCard, dueCards } from "../lib/cards";
import { effectiveBand, subscribeLevels } from "../lib/level";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { connectionForTask } from "../lib/llmConnection";
import { useSpeech } from "../hooks/useSpeech";
import { requestTranslationCards } from "../lib/llm";
import { localizeNetworkError } from "../lib/network";
import type { CardCandidate } from "../lib/parse";
import { MistakeCardPicker } from "../components/MistakeCardPicker";
import { t, getUiLanguage } from "../i18n";
import "../styles/reading.css";

/** Up to this many due-for-review card fronts get woven into passage
 * generation as spaced re-use hints (see requestReadingPassage's
 * reviewWords param and CLAUDE.md's core loop diagram) — same cap
 * rationale as PracticeView's MAX_REVIEW_WORDS_FOR_TOPIC. */
const MAX_REVIEW_WORDS = 6;

function formatDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(getUiLanguage());
}

export function ReadingView() {
  const { connection } = useLlmConnection();
  const speech = useSpeech();

  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  const [passages, setPassages] = useState<ReadingPassage[]>(() => loadPassages(settings.activeLanguage));
  useEffect(() => subscribePassages(() => setPassages(loadPassages(loadSettings().activeLanguage))), []);

  /** Estimated CEFR band for the active language, "" while unknown (see
   * lib/level.ts) — shown as a small chip next to the generate button so the
   * learner sees what difficulty new passages will target. */
  const [levelBand, setLevelBand] = useState(() => effectiveBand(settings.activeLanguage));
  useEffect(() => subscribeLevels(() => setLevelBand(effectiveBand(loadSettings().activeLanguage))), []);
  useEffect(() => setLevelBand(effectiveBand(settings.activeLanguage)), [settings.activeLanguage]);

  const [openPassageId, setOpenPassageId] = useState<string | null>(null);
  const openPassage = passages.find((p) => p.id === openPassageId) ?? null;

  useEffect(() => {
    setPassages(loadPassages(settings.activeLanguage));
    setOpenPassageId(null);
  }, [settings.activeLanguage]);

  const [revealedSentences, setRevealedSentences] = useState<Set<number>>(new Set());
  const [answerRevealed, setAnswerRevealed] = useState(false);
  const [candidates, setCandidates] = useState<CardCandidate[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [cardsAdded, setCardsAdded] = useState(0);

  useEffect(() => {
    setRevealedSentences(new Set());
    setAnswerRevealed(false);
    setCandidates(null);
    setCardsAdded(0);
  }, [openPassageId]);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!connection) {
      setError(t("reading-need-llm"));
      return;
    }
    const conn = connectionForTask("reading");
    if (!conn) return;
    setError("");
    setGenerating(true);
    try {
      const passage = await requestReadingPassage({
        connection: conn,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        reviewWords: dueCards(new Date(), settings.activeLanguage)
          .slice(0, MAX_REVIEW_WORDS)
          .map((c) => c.front),
        recentTitles: passages.slice(0, 10).map((p) => p.title),
      });
      setOpenPassageId(passage.id);
    } catch (e) {
      setError(localizeNetworkError(e, t("reading-generate-failed")));
    } finally {
      setGenerating(false);
    }
  }

  function handleDelete(id: string) {
    if (openPassageId === id) setOpenPassageId(null);
    deletePassage(id);
  }

  function toggleSentence(i: number) {
    setRevealedSentences((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function extractCards() {
    if (!openPassage || !connection) return;
    const conn = connectionForTask("cards");
    if (!conn) return;
    setError("");
    setExtracting(true);
    try {
      const found = await requestTranslationCards({
        connection: conn,
        targetLanguage: openPassage.language || settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        sourceText: openPassage.sentences.map((s) => s.translation).join(" "),
        translationText: openPassage.sentences.map((s) => s.text).join(" "),
      });
      setCandidates(found);
    } catch (e) {
      setError(localizeNetworkError(e, t("reading-extract-failed")));
    } finally {
      setExtracting(false);
    }
  }

  function addSelectedCards(selected: CardCandidate[]) {
    if (!openPassage) return;
    for (const c of selected) {
      addCard({ ...c, source: "translate", sourceTopicId: null, language: openPassage.language });
    }
    setCardsAdded(selected.length);
    setCandidates(null);
  }

  const passageLanguage = openPassage?.language || settings.activeLanguage;
  const readAllId = openPassage ? `${openPassage.id}:all` : "";
  const questionId = openPassage ? `${openPassage.id}:question` : "";

  /** The sentence div currently being read aloud during 全文を読む playback,
   * kept in view as speakSequence advances (see effect below). */
  const activeSentenceRef = useRef<HTMLDivElement | null>(null);
  const readingAllActive = !!openPassage && speech.speakingId === readAllId;
  useEffect(() => {
    if (!readingAllActive) return;
    activeSentenceRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [readingAllActive, speech.speakingIndex]);

  return (
    <div class="view-container reading-view">
      <section class="card-panel">
        <div class="topic-header">
          <h2>{t("reading-generate-heading")}</h2>
        </div>
        {!connection ? (
          <p class="hint-text">{t("reading-need-llm")}</p>
        ) : (
          <div class="button-row">
            <button type="button" class="primary-button" onClick={generate} disabled={generating}>
              <Sparkles size={16} />
              {generating ? t("reading-generating") : t("reading-generate-button")}
            </button>
            {levelBand && (
              <span class="language-badge reading-level-badge">{t("reading-level-badge", { band: levelBand })}</span>
            )}
          </div>
        )}
        {connection && <p class="hint-text">{t("reading-level-hint")}</p>}
        {error && <p class="error-text">{error}</p>}
      </section>

      <section class="card-panel">
        <h2>{t("reading-list-heading")}</h2>
        {passages.length === 0 ? (
          <p class="hint-text">{t("reading-empty-hint")}</p>
        ) : (
          <ul class="reading-passage-list">
            {passages.map((p) => (
              <li key={p.id} class={`reading-passage-item${openPassageId === p.id ? " reading-passage-item-active" : ""}`}>
                <button type="button" class="reading-passage-open" onClick={() => setOpenPassageId(p.id)}>
                  <span class="reading-passage-title">{p.title}</span>
                  <span class="reading-passage-date hint-text">{t("reading-created-date", { date: formatDate(p.createdAt) })}</span>
                  {p.reviewWords.length > 0 && (
                    <span class="reading-passage-chips">
                      {p.reviewWords.map((w) => (
                        <span key={w} class="language-badge">
                          {w}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  class="icon-button"
                  title={t("reading-delete-passage")}
                  aria-label={t("reading-delete-passage")}
                  onClick={() => handleDelete(p.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openPassage && (
        <section class="card-panel reading-pane">
          <div class="topic-header">
            <h2>{openPassage.title}</h2>
            <button type="button" class="link-button" onClick={() => setOpenPassageId(null)}>
              {t("reading-back-to-list")}
            </button>
          </div>

          <div class="button-row">
            {speech.supported && (
              <button
                type="button"
                // Per-sentence pipeline instead of one joined string: audio for the
                // first sentence starts as soon as it's fetched, with the next
                // sentence prefetched while the current one plays, rather than
                // waiting on a single huge request for the whole passage.
                onClick={() => speech.speakSequence(openPassage.sentences.map((s) => s.text), passageLanguage, readAllId)}
                disabled={speech.loadingId === readAllId}
                aria-pressed={speech.speakingId === readAllId}
              >
                {speech.loadingId === readAllId ? (
                  <Loader2 size={16} class="speak-button-spin" />
                ) : speech.speakingId === readAllId ? (
                  <Square size={16} />
                ) : (
                  <Volume2 size={16} />
                )}
                {speech.speakingId === readAllId ? t("reading-read-all-stop") : t("reading-read-all")}
              </button>
            )}
          </div>

          {openPassage.reviewWords.length > 0 && (
            <div class="reading-review-words">
              <h3>{t("reading-review-words-heading")}</h3>
              <div class="button-row">
                {openPassage.reviewWords.map((w) => (
                  <span key={w} class="language-badge">
                    {w}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class="reading-sentences">
            {openPassage.sentences.map((s, i) => {
              const sentenceId = `${openPassage.id}:s${i}`;
              const revealed = revealedSentences.has(i);
              const isReadingAllActive = readingAllActive && speech.speakingIndex === i;
              return (
                <div
                  class={`reading-sentence${isReadingAllActive ? " reading-sentence-active" : ""}`}
                  key={i}
                  ref={isReadingAllActive ? activeSentenceRef : undefined}
                >
                  <div class="reading-sentence-row">
                    <button
                      type="button"
                      class="reading-sentence-toggle"
                      aria-expanded={revealed}
                      aria-label={revealed ? t("reading-sentence-toggle-hide") : t("reading-sentence-toggle-show")}
                      onClick={() => toggleSentence(i)}
                    >
                      {s.text}
                    </button>
                    {speech.supported && (
                      <button
                        type="button"
                        class="speak-button"
                        onClick={() => speech.speak(s.text, passageLanguage, sentenceId)}
                        disabled={speech.loadingId === sentenceId}
                        aria-pressed={speech.speakingId === sentenceId}
                        aria-label={speech.speakingId === sentenceId ? t("reading-speak-sentence-stop") : t("reading-speak-sentence")}
                        title={speech.speakingId === sentenceId ? t("reading-speak-sentence-stop") : t("reading-speak-sentence")}
                      >
                        {speech.loadingId === sentenceId ? (
                          <Loader2 size={14} class="speak-button-spin" />
                        ) : speech.speakingId === sentenceId ? (
                          <Square size={14} />
                        ) : (
                          <Volume2 size={14} />
                        )}
                      </button>
                    )}
                  </div>
                  {settings.showReadingAids && s.reading && <p class="reading-aid">{s.reading}</p>}
                  {revealed && <p class="reading-sentence-translation">{s.translation}</p>}
                </div>
              );
            })}
          </div>
          {speech.speechError && <p class="speak-error">{speech.speechError}</p>}

          {openPassage.question && (
            <div class="feedback-field">
              <div class="topic-header">
                <h3>{t("reading-question-heading")}</h3>
                {speech.supported && (
                  <button
                    type="button"
                    class="speak-button"
                    onClick={() => speech.speak(openPassage.question, passageLanguage, questionId)}
                    disabled={speech.loadingId === questionId}
                    aria-pressed={speech.speakingId === questionId}
                    aria-label={speech.speakingId === questionId ? t("reading-speak-question-stop") : t("reading-speak-question")}
                    title={speech.speakingId === questionId ? t("reading-speak-question-stop") : t("reading-speak-question")}
                  >
                    {speech.loadingId === questionId ? (
                      <Loader2 size={14} class="speak-button-spin" />
                    ) : speech.speakingId === questionId ? (
                      <Square size={14} />
                    ) : (
                      <Volume2 size={14} />
                    )}
                  </button>
                )}
              </div>
              <p>{openPassage.question}</p>
              {!answerRevealed ? (
                <button type="button" class="link-button" onClick={() => setAnswerRevealed(true)}>
                  {t("reading-reveal-answer")}
                </button>
              ) : (
                <>
                  <p class="hint-text">{t("reading-question-answer-heading")}</p>
                  <p>{openPassage.questionAnswer}</p>
                  <button type="button" class="link-button" onClick={() => setAnswerRevealed(false)}>
                    {t("reading-hide-answer")}
                  </button>
                </>
              )}
            </div>
          )}

          {candidates === null ? (
            <div class="button-row">
              <button type="button" onClick={extractCards} disabled={extracting || !connection}>
                {extracting ? t("reading-extracting") : t("reading-extract-cards")}
              </button>
            </div>
          ) : candidates.length > 0 ? (
            <MistakeCardPicker
              candidates={candidates}
              onAdd={addSelectedCards}
              onClose={() => setCandidates(null)}
              ariaLabel={t("reading-vocab-picker-aria-label")}
              addLabel={t("reading-add-selected-cards")}
              cancelLabel={t("reading-vocab-picker-cancel")}
            />
          ) : (
            <p class="hint-text">{t("reading-no-cards-found")}</p>
          )}
          {cardsAdded > 0 && <p class="hint-text status-ok">{t("reading-cards-added", { count: cardsAdded })}</p>}

          {error && <p class="error-text">{error}</p>}
        </section>
      )}
    </div>
  );
}
