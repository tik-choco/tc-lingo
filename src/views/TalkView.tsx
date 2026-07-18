// 会話 (Talk) tab: meaningful, multi-turn dialogue with corrective feedback —
// the やり取り (interaction) leg of CLAUDE.md's core loop, distinct from
// 練習's one-shot topic writing. No session: pick from past conversations or
// start a fresh AI-invented scenario. Active session: a chat log (assistant
// bubbles left, learner bubbles right) with an inline, expanded-by-default
// (but still per-turn collapsible) correction under any learner line that
// needed one, plus a composer (Ctrl+Enter submits, matching PracticeView's
// convention). Every corrected reply also fires lib/autoExtract.ts's
// background mistake-card extraction (settings.autoExtractCards) and feeds
// lib/level.ts's per-language proficiency estimate. Ending a session offers
// turning any corrected learner lines into review cards via the same
// MistakeCardPicker flow as PracticeView — shown only when auto-extraction
// is off, since it would otherwise duplicate the background flow.
import { useEffect, useRef, useState } from "preact/hooks";
import { Loader2, MessageCircle, Send, Square, Trash2, Volume2 } from "lucide-preact";
import type { Card, ConversationSession, ConversationTurn } from "../types";
import {
  addConversation,
  deleteConversation,
  loadConversations,
  newTurn,
  requestConversationReply,
  requestConversationStart,
  subscribeConversations,
  updateConversation,
} from "../lib/conversation";
import { addCard } from "../lib/cards";
import { autoExtractMistakeCards } from "../lib/autoExtract";
import { effectiveBand, recordOutputSample, subscribeLevels } from "../lib/level";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { useSpeech } from "../hooks/useSpeech";
import { requestMistakeCards } from "../lib/llm";
import { localizeNetworkError } from "../lib/network";
import { changedCorrectedSentences, saveSentenceCards } from "../lib/sentenceCards";
import type { CardCandidate } from "../lib/parse";
import { MistakeCardPicker } from "../components/MistakeCardPicker";
import { SpellingDrill } from "../components/SpellingDrill";
import { diffChars } from "../lib/diff";
import { languageDisplayName } from "../lib/languages";
import { correctedSentences, misspelledWords } from "../lib/spelling";
import { t } from "../i18n";
import "../styles/talk.css";

/** Per-turn status of the "save corrected sentence(s) as SRS cards" action
 * (see lib/sentenceCards.ts), keyed by learner turn id in TalkView's
 * sentenceCardsByTurn state. Absent = not yet attempted (show the button). */
type SentenceCardsSaveState = { kind: "saving" } | { kind: "saved"; count: number } | { kind: "error"; message: string };

/** Inline, expanded-by-default correction shown under a learner bubble that
 * had something to fix (still manually collapsible per turn). Reuses
 * lib/diff.ts's character diff the same way FeedbackPanel does, just scoped
 * to one turn, so a corrected reply is visible without an extra click while
 * the log still reads as a conversation rather than a stack of feedback
 * panels. `autoAdded`, when non-empty, is the auto-extraction notice for this
 * turn (see TalkView's autoAddedByTurn) — shown outside the collapsible body
 * so it stays visible even if the learner collapses the correction.
 * `sentenceCardsState`/`onSaveSentenceCards`/`canSaveSentenceCards` drive the
 * "save corrected sentence(s) as SRS cards" affordance — shown only when
 * lib/sentenceCards.ts's changedCorrectedSentences() finds at least one
 * changed sentence, since an unchanged correction has nothing new to save.
 * A separate, opt-in "type to practice" toggle (own local state, collapsed
 * by default so the log doesn't balloon) reuses PracticeView's SpellingDrill
 * with lib/spelling.ts's misspelledWords()/correctedSentences() — hidden
 * entirely when there's nothing worth typing. `speech`/`language`/`turnId`
 * add a read-aloud button for the corrected text (same pattern as
 * FeedbackPanel's corrected field); `speech` is passed down from TalkBubble
 * rather than a fresh useSpeech() call here, since it's the single shared
 * controller for the whole log (see the comment above TalkBubble).
 * `correctedReading`/`showReadingAids` render the always-visible reading aid
 * (e.g. pinyin — see lib/languages.ts readingAid) under the corrected text,
 * gated by settings.showReadingAids the same way TalkBubble gates the
 * assistant line's reading. */
function TalkCorrection({
  original,
  corrected,
  correctedReading,
  reasons,
  autoAdded,
  sentenceCardsState,
  onSaveSentenceCards,
  canSaveSentenceCards,
  speech,
  language,
  turnId,
  showReadingAids,
}: {
  original: string;
  corrected: string;
  correctedReading: string;
  reasons: string;
  autoAdded?: Card[];
  sentenceCardsState?: SentenceCardsSaveState;
  onSaveSentenceCards: () => void;
  canSaveSentenceCards: boolean;
  speech: ReturnType<typeof useSpeech>;
  language: string;
  turnId: string;
  showReadingAids: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [typingPractice, setTypingPractice] = useState(false);
  const chunks = diffChars(original, corrected);
  const changedSentences = changedCorrectedSentences(original, corrected);
  // Typing-practice material for this turn's correction (see
  // lib/spelling.ts, reused from the 練習 tab's SpellingDrill). Computed once
  // here so the toggle button can hide itself when there's nothing to type
  // (original/corrected are effectively identical).
  const practiceWords = misspelledWords(original, corrected);
  const practiceSentences = correctedSentences(original, corrected);
  const hasTypingPractice = practiceWords.length + practiceSentences.length > 0;
  const speakId = `${turnId}-corrected`;
  const speaking = speech.speakingId === speakId;
  const loading = speech.loadingId === speakId;
  return (
    <div class="talk-correction">
      <button type="button" class="link-button talk-correction-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? t("talk-correction-hide") : t("talk-correction-show")}
      </button>
      {expanded && (
        <div class="talk-correction-body">
          {speech.supported && (
            <div class="talk-correction-speak-row">
              <button
                type="button"
                class="speak-button"
                onClick={() => speech.speak(corrected, language, speakId)}
                disabled={loading}
                aria-pressed={speaking}
                aria-label={speaking ? t("talk-speak-corrected-stop") : t("talk-speak-corrected")}
                title={speaking ? t("talk-speak-corrected-stop") : t("talk-speak-corrected")}
              >
                {loading ? <Loader2 size={14} class="speak-button-spin" /> : speaking ? <Square size={14} /> : <Volume2 size={14} />}
              </button>
            </div>
          )}
          <p class="feedback-diff">
            {chunks.map((chunk, i) => (
              <span key={i} class={chunk.op === "same" ? undefined : `diff-${chunk.op}`}>
                {chunk.op === "removed" ? null : chunk.text}
              </span>
            ))}
          </p>
          {showReadingAids && correctedReading && <p class="reading-aid">{correctedReading}</p>}
          {reasons && <p class="talk-correction-reasons">{reasons}</p>}
        </div>
      )}
      {autoAdded && autoAdded.length > 0 && (
        <p class="talk-correction-auto-added">
          {t("talk-auto-cards-added", { count: autoAdded.length })}
          <br />
          {autoAdded.map((c) => c.front).join(", ")}
        </p>
      )}
      {hasTypingPractice && (
        <div class="talk-typing-practice">
          <button
            type="button"
            class="link-button talk-typing-practice-toggle"
            onClick={() => setTypingPractice((v) => !v)}
          >
            {typingPractice ? t("talk-typing-practice-hide") : t("talk-typing-practice-show")}
          </button>
          {typingPractice && <SpellingDrill words={practiceWords} sentences={practiceSentences} />}
        </div>
      )}
      {changedSentences.length > 0 && (
        <div class="talk-sentence-cards">
          {!sentenceCardsState || sentenceCardsState.kind === "error" ? (
            <>
              <button
                type="button"
                class="link-button talk-sentence-cards-save"
                onClick={onSaveSentenceCards}
                disabled={!canSaveSentenceCards}
              >
                {t("talk-save-sentence-cards")}
              </button>
              {sentenceCardsState?.kind === "error" && <p class="error-text talk-sentence-cards-error">{sentenceCardsState.message}</p>}
            </>
          ) : sentenceCardsState.kind === "saving" ? (
            <p class="hint-text talk-sentence-cards-status">{t("talk-saving-sentence-cards")}</p>
          ) : (
            <p class="hint-text status-ok talk-sentence-cards-status">
              {sentenceCardsState.count > 0
                ? t("talk-sentence-cards-saved", { count: sentenceCardsState.count })
                : t("talk-sentence-cards-duplicate")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** `speech` is a single controller instance shared by every bubble in the
 * log (lifted to TalkView) rather than one useSpeech() per bubble — the
 * underlying Web Speech API is a single global queue, so independent
 * per-bubble instances would fight over playback and lose track of each
 * other's state. Each bubble just uses its own turn id as the toggle key. */
function TalkBubble({
  turn,
  language,
  speech,
  autoAdded,
  sentenceCardsState,
  onSaveSentenceCards,
  canSaveSentenceCards,
  showReadingAids,
}: {
  turn: ConversationTurn;
  language: string;
  speech: ReturnType<typeof useSpeech>;
  autoAdded?: Card[];
  sentenceCardsState?: SentenceCardsSaveState;
  onSaveSentenceCards: () => void;
  canSaveSentenceCards: boolean;
  showReadingAids: boolean;
}) {
  const speaking = speech.speakingId === turn.id;
  const loading = speech.loadingId === turn.id;
  return (
    <div class={`talk-bubble talk-bubble-${turn.role}`}>
      <p class="talk-bubble-text">{turn.text}</p>
      {turn.role === "assistant" && showReadingAids && turn.reading && <p class="reading-aid">{turn.reading}</p>}
      {turn.role === "assistant" && speech.supported && (
        <div class="talk-bubble-actions">
          <button
            type="button"
            class="speak-button"
            onClick={() => speech.speak(turn.text, language, turn.id)}
            disabled={loading}
            aria-pressed={speaking}
            aria-label={speaking ? t("talk-speak-stop") : t("talk-speak")}
            title={speaking ? t("talk-speak-stop") : t("talk-speak")}
          >
            {loading ? <Loader2 size={14} class="speak-button-spin" /> : speaking ? <Square size={14} /> : <Volume2 size={14} />}
          </button>
        </div>
      )}
      {turn.role === "learner" && turn.corrected && (
        <TalkCorrection
          original={turn.text}
          corrected={turn.corrected}
          correctedReading={turn.correctedReading}
          reasons={turn.reasons}
          autoAdded={autoAdded}
          sentenceCardsState={sentenceCardsState}
          onSaveSentenceCards={onSaveSentenceCards}
          canSaveSentenceCards={canSaveSentenceCards}
          speech={speech}
          language={language}
          turnId={turn.id}
          showReadingAids={showReadingAids}
        />
      )}
    </div>
  );
}

export function TalkView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const { connection } = useLlmConnection();
  const speech = useSpeech();

  const [sessions, setSessions] = useState<ConversationSession[]>(() => loadConversations(settings.activeLanguage));
  useEffect(() => subscribeConversations(() => setSessions(loadConversations(loadSettings().activeLanguage))), []);
  useEffect(() => setSessions(loadConversations(settings.activeLanguage)), [settings.activeLanguage]);

  /** Estimated CEFR band for the active language, "" while unknown (see
   * lib/level.ts) — shown as a small chip next to the start button so the
   * learner sees what difficulty the conversation partner will target
   * (mirrors ReadingView's levelBand). */
  const [levelBand, setLevelBand] = useState(() => effectiveBand(settings.activeLanguage));
  useEffect(() => subscribeLevels(() => setLevelBand(effectiveBand(loadSettings().activeLanguage))), []);
  useEffect(() => setLevelBand(effectiveBand(settings.activeLanguage)), [settings.activeLanguage]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const sessionLanguage = activeSession ? activeSession.language || settings.activeLanguage : settings.activeLanguage;

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const [candidates, setCandidates] = useState<CardCandidate[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [cardsAdded, setCardsAdded] = useState(0);

  // Background auto-extraction notices, keyed by the learner turn id they
  // belong to. Populated fire-and-forget from sendMessage once
  // autoExtractMistakeCards resolves — never persisted, and never blocks the
  // chat flow or the typing indicator.
  const [autoAddedByTurn, setAutoAddedByTurn] = useState<Record<string, Card[]>>({});

  // "Save corrected sentence(s) as SRS cards" status per learner turn id
  // (see TalkCorrection / lib/sentenceCards.ts) — manual, learner-triggered,
  // independent of the background auto-extraction above.
  const [sentenceCardsByTurn, setSentenceCardsByTurn] = useState<Record<string, SentenceCardsSaveState>>({});

  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (activeSession && !activeSession.endedAt) composerRef.current?.focus();
  }, [activeSession?.id]);

  function resetSessionUiState() {
    setText("");
    setSendError("");
    setCandidates(null);
    setExtractError("");
    setCardsAdded(0);
    setAutoAddedByTurn({});
    setSentenceCardsByTurn({});
  }

  function openSession(id: string) {
    resetSessionUiState();
    setActiveId(id);
  }

  function backToList() {
    resetSessionUiState();
    setActiveId(null);
  }

  async function startConversation() {
    if (!connection) {
      setStartError(t("talk-need-llm"));
      return;
    }
    setStartError("");
    setStarting(true);
    try {
      const result = await requestConversationStart({
        connection,
        targetLanguage: settings.activeLanguage,
        nativeLanguage: settings.nativeLanguage,
        recentTitles: sessions.slice(0, 10).map((s) => s.title),
      });
      const opening = newTurn({ role: "assistant", text: result.opening, reading: result.openingReading });
      const session = addConversation({
        language: settings.activeLanguage,
        title: result.title,
        scenario: result.scenario,
        turns: [opening],
      });
      openSession(session.id);
    } catch (e) {
      setStartError(localizeNetworkError(e, t("talk-start-failed")));
    } finally {
      setStarting(false);
    }
  }

  async function sendMessage(event: Event) {
    event.preventDefault();
    if (!activeSession || activeSession.endedAt || !text.trim()) return;
    if (!connection) {
      setSendError(t("talk-need-llm"));
      return;
    }
    setSendError("");
    setSending(true);
    const learnerText = text;
    try {
      const result = await requestConversationReply({
        connection,
        targetLanguage: sessionLanguage,
        nativeLanguage: settings.nativeLanguage,
        scenario: activeSession.scenario,
        turns: activeSession.turns,
        learnerText,
      });
      const learnerTurn = newTurn({
        role: "learner",
        text: learnerText,
        corrected: result.corrected,
        correctedReading: result.correctedReading,
        reasons: result.reasons,
      });
      const assistantTurn = newTurn({ role: "assistant", text: result.reply, reading: result.replyReading });
      updateConversation(activeSession.id, { turns: [...activeSession.turns, learnerTurn, assistantTurn] });
      setText("");

      // Feed the per-language proficiency estimate (lib/level.ts) — a
      // flawless turn (corrected === "") is a positive signal too.
      recordOutputSample(sessionLanguage, learnerText, result.corrected);

      // Fire-and-forget background mistake-card extraction (lib/autoExtract.ts):
      // never awaited, so it can't block the chat flow or the typing
      // indicator. Gates on settings.autoExtractCards itself; the resolved
      // notice is attached to this learner turn's correction block.
      if (result.corrected.trim()) {
        autoExtractMistakeCards({
          connection,
          targetLanguage: sessionLanguage,
          nativeLanguage: settings.nativeLanguage,
          original: learnerText,
          corrected: result.corrected,
          reasons: result.reasons,
          sourceTopicId: null,
        }).then((added) => {
          if (added.length > 0) setAutoAddedByTurn((prev) => ({ ...prev, [learnerTurn.id]: added }));
        });
      }
    } catch (e) {
      setSendError(localizeNetworkError(e, t("talk-send-failed")));
    } finally {
      setSending(false);
    }
  }

  /** Manually save the changed sentence(s) in one learner turn's correction
   * as SRS cards (lib/sentenceCards.ts) — distinct from the background
   * auto-extraction above: learner-triggered, per-turn, and always offered
   * regardless of settings.autoExtractCards. */
  async function saveTurnSentenceCards(turn: ConversationTurn) {
    if (!connection || !turn.corrected) return;
    setSentenceCardsByTurn((prev) => ({ ...prev, [turn.id]: { kind: "saving" } }));
    try {
      const added = await saveSentenceCards({
        connection,
        targetLanguage: sessionLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: turn.text,
        corrected: turn.corrected,
        sourceTopicId: null,
      });
      setSentenceCardsByTurn((prev) => ({ ...prev, [turn.id]: { kind: "saved", count: added.length } }));
    } catch (e) {
      setSentenceCardsByTurn((prev) => ({
        ...prev,
        [turn.id]: { kind: "error", message: localizeNetworkError(e, t("talk-save-sentence-failed")) },
      }));
    }
  }

  function endSession() {
    if (!activeSession) return;
    updateConversation(activeSession.id, { endedAt: new Date().toISOString() });
  }

  const correctedTurns = activeSession ? activeSession.turns.filter((turn) => turn.role === "learner" && turn.corrected) : [];

  async function extractCards() {
    if (!activeSession || !connection || correctedTurns.length === 0) return;
    setExtractError("");
    setExtracting(true);
    try {
      const found = await requestMistakeCards({
        connection,
        targetLanguage: sessionLanguage,
        nativeLanguage: settings.nativeLanguage,
        original: correctedTurns.map((turn) => turn.text).join("\n"),
        corrected: correctedTurns.map((turn) => turn.corrected).join("\n"),
        reasons: correctedTurns.map((turn) => turn.reasons).filter(Boolean).join("\n"),
      });
      setCandidates(found);
    } catch (e) {
      setExtractError(localizeNetworkError(e, t("talk-extract-failed")));
    } finally {
      setExtracting(false);
    }
  }

  function addSelectedCards(selected: CardCandidate[]) {
    if (!activeSession) return;
    for (const c of selected) {
      addCard({ ...c, source: "mistake", sourceTopicId: null, language: activeSession.language });
    }
    setCardsAdded(selected.length);
    setCandidates(null);
  }

  if (!activeSession) {
    return (
      <div class="view-container talk-view">
        <section class="card-panel">
          <h2>{t("talk-start-heading")}</h2>
          <p class="hint-text">{t("talk-start-hint")}</p>
          <div class="button-row">
            <button type="button" class="primary-button" onClick={startConversation} disabled={starting}>
              <MessageCircle size={16} />
              {starting ? t("talk-starting") : t("talk-start-button")}
            </button>
            {levelBand && <span class="language-badge talk-level-badge">{t("talk-level-badge", { band: levelBand })}</span>}
          </div>
          {!connection && <p class="hint-text status-warn">{t("talk-need-llm")}</p>}
          {connection && <p class="hint-text">{t("talk-level-hint")}</p>}
          {startError && <p class="error-text">{startError}</p>}
        </section>

        {sessions.length > 0 && (
          <section class="card-panel">
            <h2>{t("talk-past-sessions-heading")}</h2>
            <ul class="talk-session-list">
              {sessions.map((s) => (
                <li key={s.id} class="talk-session-item">
                  <button type="button" class="talk-session-open" onClick={() => openSession(s.id)}>
                    <span class="talk-session-title">{s.title}</span>
                    <span class="talk-session-meta">
                      <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                      <span>{t("talk-turn-count", { count: s.turns.length })}</span>
                      {s.endedAt && <span class="talk-ended-badge">{t("talk-ended-badge")}</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="icon-button talk-session-delete"
                    onClick={() => deleteConversation(s.id)}
                    aria-label={t("talk-delete-session")}
                    title={t("talk-delete-session")}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return (
    <div class="view-container talk-view">
      <section class="card-panel talk-panel">
        <div class="topic-header">
          <h2>{activeSession.title}</h2>
          {activeSession.endedAt && <span class="talk-ended-badge">{t("talk-ended-badge")}</span>}
        </div>
        {activeSession.scenario && <p class="talk-scenario">{activeSession.scenario}</p>}

        <div class="talk-log">
          {activeSession.turns.map((turn) => (
            <TalkBubble
              key={turn.id}
              turn={turn}
              language={sessionLanguage}
              speech={speech}
              autoAdded={autoAddedByTurn[turn.id]}
              sentenceCardsState={sentenceCardsByTurn[turn.id]}
              onSaveSentenceCards={() => saveTurnSentenceCards(turn)}
              canSaveSentenceCards={!!connection}
              showReadingAids={settings.showReadingAids}
            />
          ))}
          {sending && <p class="talk-typing-indicator">{t("talk-typing")}</p>}
        </div>
        {speech.speechError && <p class="speak-error">{speech.speechError}</p>}

        {!activeSession.endedAt && (
          <form class="talk-composer" onSubmit={sendMessage}>
            <textarea
              ref={composerRef}
              class="practice-textarea"
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !sending && text.trim()) {
                  e.preventDefault();
                  sendMessage(e);
                }
              }}
              rows={3}
              placeholder={t("talk-composer-placeholder", { language: languageDisplayName(sessionLanguage) })}
            />
            <div class="button-row">
              <button type="submit" class="primary-button" disabled={sending || !text.trim()}>
                <Send size={16} />
                {sending ? (
                  t("talk-sending")
                ) : (
                  <>
                    {t("talk-send")} <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Enter</kbd>
                  </>
                )}
              </button>
              <button type="button" onClick={endSession}>
                {t("talk-end-session")}
              </button>
            </div>
            {sendError && <p class="error-text">{sendError}</p>}
          </form>
        )}

        {activeSession.endedAt && correctedTurns.length > 0 && !settings.autoExtractCards && (
          <div class="talk-extract">
            {candidates === null ? (
              <div class="button-row">
                <button type="button" onClick={extractCards} disabled={extracting || !connection}>
                  {extracting ? t("talk-extracting") : t("talk-extract-cards")}
                </button>
              </div>
            ) : candidates.length > 0 ? (
              <MistakeCardPicker candidates={candidates} onAdd={addSelectedCards} onClose={() => setCandidates(null)} />
            ) : (
              <p class="hint-text">{t("talk-no-cards-found")}</p>
            )}
            {cardsAdded > 0 && <p class="hint-text status-ok">{t("talk-cards-added", { count: cardsAdded })}</p>}
            {extractError && <p class="error-text">{extractError}</p>}
          </div>
        )}

        <div class="button-row">
          <button type="button" onClick={backToList}>
            {t("talk-back-to-list")}
          </button>
        </div>
      </section>
    </div>
  );
}
