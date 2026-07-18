import { useEffect, useRef, useState } from "preact/hooks";
import { ChevronDown, ChevronUp, Loader2, Pencil, Square, Trash2, Volume2 } from "lucide-preact";
import { addCard, deleteCard, loadCards, subscribeCards, updateCard } from "../lib/cards";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { loadTopics } from "../lib/topics";
import { languageDisplayName, readingSpec } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { MistakeCardPicker } from "../components/MistakeCardPicker";
import { getUiLanguage, t } from "../i18n";
import { useSpeech } from "../hooks/useSpeech";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { localizeNetworkError } from "../lib/network";
import { requestTranslationCards } from "../lib/llm";
import type { CardCandidate } from "../lib/parse";
import {
  dismiss,
  loadInboxItems,
  markImported,
  resolvePayload,
  subscribeInbox,
} from "../lib/cardInbox";
import type { LingoCardInboxItem, LingoCardPayloadV1 } from "../lib/cardInbox";
import { deterministicCandidates } from "../lib/inboxCandidates";
import type { LlmConnection } from "../lib/llmConnection";
import type { Card } from "../types";

/** Days until due relative to local midnight; null for an unparsable date. */
function dueDiffDays(dueAt: string): number | null {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

function formatDue(diffDays: number | null): string {
  if (diffDays === null) return "";
  if (diffDays <= 0) return t("cards-due-ready");
  if (diffDays === 1) return t("cards-due-tomorrow");
  return t("cards-due-days", { days: diffDays });
}

/** Fetch state for one inbox row's payload — driven by lib/cardInbox.ts's
 * resolvePayload, kept local to the row instead of lifted to CardsView since
 * only one item is ever expanded/resolving at a time in practice, and
 * per-row state keeps each row's async fetch independent of the others. */
type RowResolution = { kind: "idle" } | { kind: "loading" } | { kind: "ok"; payload: LingoCardPayloadV1 } | { kind: "transient" } | { kind: "permanent" };

/** One `lingo-card-inbox` row: collapsed shows just the sender's lightweight
 * preview (no CID fetch yet); expanding triggers `resolvePayload` and, once
 * resolved, shows the deterministic candidates (see lib/inboxCandidates.ts)
 * through the shared MistakeCardPicker, plus an optional AI-assisted
 * extraction pass that appends more candidates to the same picker. */
function InboxItemRow({
  item,
  cards,
  connection,
  nativeLanguage,
}: {
  item: LingoCardInboxItem;
  cards: Card[];
  connection: LlmConnection | null;
  nativeLanguage: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolution, setResolution] = useState<RowResolution>({ kind: "idle" });
  const [candidates, setCandidates] = useState<CardCandidate[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");

  async function resolve() {
    setResolution({ kind: "loading" });
    setError("");
    const result = await resolvePayload(item);
    if (result.kind === "resolved") {
      setCandidates(deterministicCandidates(item, result.payload));
      setResolution({ kind: "ok", payload: result.payload });
    } else {
      // "permanent" already recorded dismiss(item.id) inside resolvePayload;
      // this row disappears on the next inbox refresh (subscribeInbox fires
      // off that same storage write) before the "invalid" message below
      // matters much, but it's accurate for the brief moment it's visible.
      setResolution({ kind: result.kind });
    }
  }

  function toggleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (resolution.kind === "idle") resolve();
  }

  async function extractWithAi() {
    if (!connection || resolution.kind !== "ok") return;
    setExtracting(true);
    setError("");
    try {
      const payload = resolution.payload;
      const natural = payload.translations.find((tr) => tr.tone === "Natural") ?? payload.translations[0];
      const found = await requestTranslationCards({
        connection,
        targetLanguage: item.targetLanguage,
        nativeLanguage,
        sourceText: payload.sourceText,
        translationText: natural?.text ?? "",
      });
      setCandidates((prev) => [...prev, ...found]);
    } catch (e) {
      setError(localizeNetworkError(e, t("cards-inbox-extract-failed")));
    } finally {
      setExtracting(false);
    }
  }

  function addSelected(selected: CardCandidate[]) {
    for (const c of selected) {
      addCard({ ...c, source: "translate", sourceTopicId: null, language: item.targetLanguage });
    }
    markImported(item.id);
  }

  const duplicateFlags = candidates.map((c) => cards.some((existing) => existing.front === c.front && existing.language === item.targetLanguage));

  return (
    <li class="card-list-entry">
      <div class="card-list-item card-list-clickable" onClick={toggleExpand}>
        <div class="card-list-main">
          <strong>{item.sourcePreview}</strong>
        </div>
        <div class="card-list-meta">
          <span class="source-badge">{t(item.kind === "explain" ? "cards-inbox-kind-explain" : "cards-inbox-kind-translate")}</span>
          <span class="language-badge">{languageDisplayName(item.targetLanguage)}</span>
          <button
            type="button"
            class="icon-button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand();
            }}
            title={expanded ? t("cards-collapse-title") : t("cards-expand-title")}
            aria-label={expanded ? t("cards-collapse-title") : t("cards-expand-title")}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            type="button"
            class="icon-button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(item.id);
            }}
            title={t("cards-inbox-dismiss-title")}
            aria-label={t("cards-inbox-dismiss-title")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {expanded && (
        <div class="card-list-detail">
          {resolution.kind === "loading" && <p class="hint-text">{t("cards-inbox-loading")}</p>}
          {resolution.kind === "transient" && (
            <p class="error-text">
              {t("cards-inbox-fetch-failed")}{" "}
              <button type="button" class="link-button" onClick={resolve}>
                {t("cards-inbox-retry")}
              </button>
            </p>
          )}
          {resolution.kind === "permanent" && <p class="error-text">{t("cards-inbox-invalid")}</p>}
          {resolution.kind === "ok" && (
            <>
              {error && <p class="error-text">{error}</p>}
              {candidates.length === 0 ? (
                <p class="hint-text">{t("cards-inbox-no-candidates")}</p>
              ) : (
                <MistakeCardPicker
                  candidates={candidates}
                  duplicateFlags={duplicateFlags}
                  ariaLabel={t("cards-inbox-picker-aria-label")}
                  addLabel={t("cards-inbox-add-selected")}
                  cancelLabel={t("cards-inbox-picker-cancel")}
                  duplicateLabel={t("cards-inbox-already-added")}
                  onAdd={addSelected}
                  onClose={() => setExpanded(false)}
                />
              )}
              {connection && (
                <button type="button" onClick={extractWithAi} disabled={extracting}>
                  {extracting ? t("cards-inbox-extracting") : t("cards-inbox-extract-ai")}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function CardsView() {
  const [cards, setCards] = useState<Card[]>(loadCards);
  useEffect(() => subscribeCards(() => setCards(loadCards())), []);

  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  const { connection } = useLlmConnection();

  const [inboxItems, setInboxItems] = useState<LingoCardInboxItem[]>(loadInboxItems);
  useEffect(() => subscribeInbox(() => setInboxItems(loadInboxItems())), []);
  const [showInbox, setShowInbox] = useState(false);

  const speech = useSpeech();

  const [showForm, setShowForm] = useState(false);
  const [front, setFront] = useState("");
  const [reading, setReading] = useState("");
  const [meaning, setMeaning] = useState("");
  const [exampleSentence, setExampleSentence] = useState("");
  const [context, setContext] = useState("");
  const [cloze, setCloze] = useState("");
  const [language, setLanguage] = useState(settings.activeLanguage);
  // Refocused after a successful add so keyboard-only users can keep
  // entering cards without reaching for the mouse.
  const frontInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setLanguage(settings.activeLanguage);
  }, [settings.activeLanguage]);

  // Which source topic a "from your mistake" card came from — loaded once;
  // topic list churn while this view is open is rare enough not to warrant
  // a live subscription here.
  const [topics] = useState(() => loadTopics());

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFront, setEditFront] = useState("");
  const [editReading, setEditReading] = useState("");
  const [editMeaning, setEditMeaning] = useState("");
  const [editExample, setEditExample] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editCloze, setEditCloze] = useState("");

  function startEdit(c: Card) {
    setEditingId(c.id);
    setEditFront(c.front);
    setEditReading(c.reading);
    setEditMeaning(c.meaning);
    setEditExample(c.exampleSentence);
    setEditContext(c.context);
    setEditCloze(c.cloze);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function saveEdit(event: Event, id: string) {
    event.preventDefault();
    if (!canSubmitEdit()) return;
    updateCard(id, {
      front: editFront,
      reading: editReading,
      meaning: editMeaning,
      exampleSentence: editExample,
      context: editContext,
      cloze: editCloze,
    });
    setEditingId(null);
  }

  function sourceTopicTitle(c: Card): string | null {
    if ((c.source !== "mistake" && c.source !== "sentence") || !c.sourceTopicId) return null;
    return topics.find((tp) => tp.id === c.sourceTopicId)?.title ?? null;
  }

  function canSubmitNew(): boolean {
    return front.trim() !== "" && meaning.trim() !== "";
  }

  function submit(event: Event) {
    event.preventDefault();
    if (!canSubmitNew()) return;
    addCard({
      front,
      reading,
      meaning,
      exampleSentence,
      context,
      cloze,
      source: "manual",
      language: settings.targetLanguages.length > 1 ? language : settings.targetLanguages[0],
    });
    setFront("");
    setReading("");
    setMeaning("");
    setExampleSentence("");
    setContext("");
    setCloze("");
    setLanguage(settings.activeLanguage);
    // Keep the form open and return focus to the first field so a
    // keyboard-only user can immediately enter the next card.
    frontInputRef.current?.focus();
  }

  // Ctrl+Enter / Cmd+Enter submits the new-card form from any of its fields.
  function handleNewCardKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canSubmitNew()) {
      e.preventDefault();
      submit(e);
    }
  }

  function canSubmitEdit(): boolean {
    return editFront.trim() !== "" && editMeaning.trim() !== "";
  }

  // Ctrl+Enter / Cmd+Enter saves the in-place edit form from any of its fields.
  function handleEditKeyDown(e: KeyboardEvent, id: string) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canSubmitEdit()) {
      e.preventDefault();
      saveEdit(e, id);
    }
  }

  const visible = cards.filter((c) => !c.language || c.language === settings.activeLanguage);
  const sorted = [...visible].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  const cardLanguage = settings.targetLanguages.length > 1 ? language : settings.targetLanguages[0];
  const readingField = readingSpec(cardLanguage);

  return (
    <div class="view-container cards-view">
      <section class="card-panel">
        <div class="topic-header">
          <h2>{t("cards-heading", { count: visible.length })}</h2>
          <button type="button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? t("cards-close") : t("cards-add-button")}
          </button>
        </div>

        {showForm && (
          <form class="field-grid" onSubmit={submit}>
            <label>
              {t("cards-label-front")}
              <input
                ref={frontInputRef}
                type="text"
                value={front}
                onInput={(e) => setFront((e.target as HTMLInputElement).value)}
                onKeyDown={handleNewCardKeyDown}
              />
            </label>
            <label>
              {t("cards-reading-optional", { label: readingField.label })}
              <input
                type="text"
                value={reading}
                onInput={(e) => setReading((e.target as HTMLInputElement).value)}
                onKeyDown={handleNewCardKeyDown}
                placeholder={readingField.placeholder}
              />
            </label>
            <label>
              {t("cards-label-meaning")}
              <input
                type="text"
                value={meaning}
                onInput={(e) => setMeaning((e.target as HTMLInputElement).value)}
                onKeyDown={handleNewCardKeyDown}
              />
            </label>
            <label>
              {t("cards-label-example")}
              <input
                type="text"
                value={exampleSentence}
                onInput={(e) => setExampleSentence((e.target as HTMLInputElement).value)}
                onKeyDown={handleNewCardKeyDown}
              />
            </label>
            <label>
              {t("cards-label-context")}
              <input
                type="text"
                value={context}
                onInput={(e) => setContext((e.target as HTMLInputElement).value)}
                onKeyDown={handleNewCardKeyDown}
              />
            </label>
            <label>
              {t("cards-label-cloze")}
              <input
                type="text"
                value={cloze}
                onInput={(e) => setCloze((e.target as HTMLInputElement).value)}
                onKeyDown={handleNewCardKeyDown}
              />
            </label>
            {settings.targetLanguages.length > 1 && (
              <label>
                {t("cards-label-language")}
                <LanguageSelect value={language} onChange={setLanguage} ariaLabel={t("cards-language-aria-label")} />
              </label>
            )}
            <div class="button-row">
              <button type="submit" class="primary-button">
                {t("cards-submit")}
              </button>
              <span class="hint-text">
                <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Enter</kbd>
              </span>
            </div>
          </form>
        )}
      </section>

      <section class="card-panel">
        <div class="topic-header">
          <h2>{t("cards-inbox-heading", { count: inboxItems.length })}</h2>
          <button type="button" onClick={() => setShowInbox((v) => !v)}>
            {showInbox ? t("cards-close") : t("cards-inbox-open")}
          </button>
        </div>

        {showInbox &&
          (inboxItems.length === 0 ? (
            <p class="hint-text">{t("cards-inbox-empty")}</p>
          ) : (
            <ul class="card-list">
              {inboxItems.map((item) => (
                <InboxItemRow key={item.id} item={item} cards={cards} connection={connection} nativeLanguage={settings.nativeLanguage} />
              ))}
            </ul>
          ))}
      </section>

      <section class="card-panel">
        {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
        {sorted.length === 0 ? (
          <p class="hint-text">{t("cards-empty")}</p>
        ) : (
          <ul class="card-list">
            {sorted.map((c) => {
              const expanded = expandedIds.has(c.id);
              const isEditing = editingId === c.id;
              const topicTitle = sourceTopicTitle(c);
              const editReadingField = readingSpec(c.language || settings.activeLanguage);
              return (
                <li key={c.id} class="card-list-entry">
                  <div class="card-list-item card-list-clickable" onClick={() => toggleExpand(c.id)}>
                    <div class="card-list-main">
                      <strong>{c.front}</strong>
                      {c.reading && <span class="card-list-reading"> ({c.reading})</span>}
                      <span class="card-list-meaning"> — {c.meaning}</span>
                    </div>
                    <div class="card-list-meta">
                      <span class={`due-badge${(dueDiffDays(c.dueAt) ?? 1) <= 0 ? " due-badge-ready" : ""}`}>
                        {formatDue(dueDiffDays(c.dueAt))}
                      </span>
                      {c.source === "mistake" && <span class="source-badge">{t("cards-source-mistake")}</span>}
                      {c.source === "translate" && <span class="source-badge">{t("cards-source-translate")}</span>}
                      {c.source === "sentence" && <span class="source-badge">{t("cards-source-sentence")}</span>}
                      {!c.cloze && <span class="cloze-missing-badge">{t("cards-cloze-missing")}</span>}
                      {settings.targetLanguages.length > 1 && c.language && (
                        <span class="language-badge">{languageDisplayName(c.language)}</span>
                      )}
                      {speech.supported && (
                        <button
                          type="button"
                          class="speak-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            speech.speak(c.front, c.language || settings.activeLanguage, `${c.id}:front`);
                          }}
                          disabled={speech.loadingId === `${c.id}:front`}
                          aria-pressed={speech.speakingId === `${c.id}:front`}
                          aria-label={
                            speech.speakingId === `${c.id}:front` ? t("cards-speak-front-stop") : t("cards-speak-front")
                          }
                          title={speech.speakingId === `${c.id}:front` ? t("cards-speak-front-stop") : t("cards-speak-front")}
                        >
                          {speech.loadingId === `${c.id}:front` ? (
                            <Loader2 size={14} class="speak-button-spin" />
                          ) : speech.speakingId === `${c.id}:front` ? (
                            <Square size={14} />
                          ) : (
                            <Volume2 size={14} />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        class="icon-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(c.id);
                        }}
                        title={expanded ? t("cards-collapse-title") : t("cards-expand-title")}
                        aria-label={expanded ? t("cards-collapse-title") : t("cards-expand-title")}
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCard(c.id);
                        }}
                        title={t("cards-delete-title")}
                        aria-label={t("cards-delete-title")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {expanded &&
                    (isEditing ? (
                      <form class="field-grid card-list-detail" onSubmit={(e) => saveEdit(e, c.id)}>
                        <label>
                          {t("cards-label-front")}
                          <input
                            type="text"
                            value={editFront}
                            onInput={(e) => setEditFront((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => handleEditKeyDown(e, c.id)}
                          />
                        </label>
                        <label>
                          {t("cards-reading-optional", { label: editReadingField.label })}
                          <input
                            type="text"
                            value={editReading}
                            onInput={(e) => setEditReading((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => handleEditKeyDown(e, c.id)}
                            placeholder={editReadingField.placeholder}
                          />
                        </label>
                        <label>
                          {t("cards-label-meaning")}
                          <input
                            type="text"
                            value={editMeaning}
                            onInput={(e) => setEditMeaning((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => handleEditKeyDown(e, c.id)}
                          />
                        </label>
                        <label>
                          {t("cards-label-example")}
                          <input
                            type="text"
                            value={editExample}
                            onInput={(e) => setEditExample((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => handleEditKeyDown(e, c.id)}
                          />
                        </label>
                        <label>
                          {t("cards-label-context")}
                          <input
                            type="text"
                            value={editContext}
                            onInput={(e) => setEditContext((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => handleEditKeyDown(e, c.id)}
                          />
                        </label>
                        <label>
                          {t("cards-label-cloze")}
                          <input
                            type="text"
                            value={editCloze}
                            onInput={(e) => setEditCloze((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => handleEditKeyDown(e, c.id)}
                          />
                        </label>
                        <div class="button-row">
                          <button type="submit" class="primary-button">
                            {t("cards-save-button")}
                          </button>
                          <button type="button" onClick={cancelEdit}>
                            {t("cards-cancel-button")}
                          </button>
                          <span class="hint-text">
                            <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Enter</kbd>
                          </span>
                        </div>
                      </form>
                    ) : (
                      <div class="card-list-detail">
                        {c.exampleSentence && (
                          <p class="card-detail-row">
                            <span class="card-detail-label">{t("cards-detail-example")}</span>
                            {c.exampleSentence}
                            {speech.supported && (
                              <button
                                type="button"
                                class="speak-button"
                                onClick={() =>
                                  speech.speak(c.exampleSentence, c.language || settings.activeLanguage, `${c.id}:example`)
                                }
                                disabled={speech.loadingId === `${c.id}:example`}
                                aria-pressed={speech.speakingId === `${c.id}:example`}
                                aria-label={
                                  speech.speakingId === `${c.id}:example`
                                    ? t("cards-speak-example-stop")
                                    : t("cards-speak-example")
                                }
                                title={
                                  speech.speakingId === `${c.id}:example`
                                    ? t("cards-speak-example-stop")
                                    : t("cards-speak-example")
                                }
                              >
                                {speech.loadingId === `${c.id}:example` ? (
                                  <Loader2 size={14} class="speak-button-spin" />
                                ) : speech.speakingId === `${c.id}:example` ? (
                                  <Square size={14} />
                                ) : (
                                  <Volume2 size={14} />
                                )}
                              </button>
                            )}
                          </p>
                        )}
                        {c.context && (
                          <p class="card-detail-row">
                            <span class="card-detail-label">{t("cards-detail-context")}</span>
                            {c.context}
                          </p>
                        )}
                        {c.cloze && (
                          <p class="card-detail-row">
                            <span class="card-detail-label">{t("cards-detail-cloze")}</span>
                            {c.cloze}
                          </p>
                        )}
                        {topicTitle && (
                          <p class="card-detail-row card-detail-source">
                            {t("cards-detail-source-topic", { title: topicTitle })}
                          </p>
                        )}
                        <div class="card-detail-stats">
                          <span>
                            {t("cards-detail-created", {
                              date: new Date(c.createdAt).toLocaleDateString(getUiLanguage()),
                            })}
                          </span>
                          <span>
                            {t("cards-detail-stats", {
                              reps: c.reps,
                              lapses: c.lapses,
                              interval: c.intervalDays,
                            })}
                          </span>
                        </div>
                        <button type="button" class="link-button" onClick={() => startEdit(c)}>
                          <Pencil size={14} /> {t("cards-edit-button")}
                        </button>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
