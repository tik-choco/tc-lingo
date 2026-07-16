import { useEffect, useState } from "preact/hooks";
import { ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-preact";
import { addCard, deleteCard, loadCards, subscribeCards, updateCard } from "../lib/cards";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { loadTopics } from "../lib/topics";
import { languageDisplayName, readingSpec } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { getUiLanguage, t } from "../i18n";
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

export function CardsView() {
  const [cards, setCards] = useState<Card[]>(loadCards);
  useEffect(() => subscribeCards(() => setCards(loadCards())), []);

  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  const [showForm, setShowForm] = useState(false);
  const [front, setFront] = useState("");
  const [reading, setReading] = useState("");
  const [meaning, setMeaning] = useState("");
  const [exampleSentence, setExampleSentence] = useState("");
  const [context, setContext] = useState("");
  const [cloze, setCloze] = useState("");
  const [language, setLanguage] = useState(settings.activeLanguage);
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
    if (!editFront.trim() || !editMeaning.trim()) return;
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
    if (c.source !== "mistake" || !c.sourceTopicId) return null;
    return topics.find((tp) => tp.id === c.sourceTopicId)?.title ?? null;
  }

  function submit(event: Event) {
    event.preventDefault();
    if (!front.trim() || !meaning.trim()) return;
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
    setShowForm(false);
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
              <input type="text" value={front} onInput={(e) => setFront((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              {t("cards-reading-optional", { label: readingField.label })}
              <input
                type="text"
                value={reading}
                onInput={(e) => setReading((e.target as HTMLInputElement).value)}
                placeholder={readingField.placeholder}
              />
            </label>
            <label>
              {t("cards-label-meaning")}
              <input type="text" value={meaning} onInput={(e) => setMeaning((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              {t("cards-label-example")}
              <input
                type="text"
                value={exampleSentence}
                onInput={(e) => setExampleSentence((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              {t("cards-label-context")}
              <input type="text" value={context} onInput={(e) => setContext((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              {t("cards-label-cloze")}
              <input type="text" value={cloze} onInput={(e) => setCloze((e.target as HTMLInputElement).value)} />
            </label>
            {settings.targetLanguages.length > 1 && (
              <label>
                {t("cards-label-language")}
                <LanguageSelect value={language} onChange={setLanguage} ariaLabel={t("cards-language-aria-label")} />
              </label>
            )}
            <button type="submit" class="primary-button">
              {t("cards-submit")}
            </button>
          </form>
        )}
      </section>

      <section class="card-panel">
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
                      {!c.cloze && <span class="cloze-missing-badge">{t("cards-cloze-missing")}</span>}
                      {settings.targetLanguages.length > 1 && c.language && (
                        <span class="language-badge">{languageDisplayName(c.language)}</span>
                      )}
                      <button
                        type="button"
                        class="icon-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(c.id);
                        }}
                        title={expanded ? t("cards-collapse-title") : t("cards-expand-title")}
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
                          />
                        </label>
                        <label>
                          {t("cards-reading-optional", { label: editReadingField.label })}
                          <input
                            type="text"
                            value={editReading}
                            onInput={(e) => setEditReading((e.target as HTMLInputElement).value)}
                            placeholder={editReadingField.placeholder}
                          />
                        </label>
                        <label>
                          {t("cards-label-meaning")}
                          <input
                            type="text"
                            value={editMeaning}
                            onInput={(e) => setEditMeaning((e.target as HTMLInputElement).value)}
                          />
                        </label>
                        <label>
                          {t("cards-label-example")}
                          <input
                            type="text"
                            value={editExample}
                            onInput={(e) => setEditExample((e.target as HTMLInputElement).value)}
                          />
                        </label>
                        <label>
                          {t("cards-label-context")}
                          <input
                            type="text"
                            value={editContext}
                            onInput={(e) => setEditContext((e.target as HTMLInputElement).value)}
                          />
                        </label>
                        <label>
                          {t("cards-label-cloze")}
                          <input
                            type="text"
                            value={editCloze}
                            onInput={(e) => setEditCloze((e.target as HTMLInputElement).value)}
                          />
                        </label>
                        <div class="button-row">
                          <button type="submit" class="primary-button">
                            {t("cards-save-button")}
                          </button>
                          <button type="button" onClick={cancelEdit}>
                            {t("cards-cancel-button")}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div class="card-list-detail">
                        {c.exampleSentence && (
                          <p class="card-detail-row">
                            <span class="card-detail-label">{t("cards-detail-example")}</span>
                            {c.exampleSentence}
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
