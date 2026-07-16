import { useEffect, useState } from "preact/hooks";
import { Trash2 } from "lucide-preact";
import { addCard, deleteCard, loadCards, subscribeCards } from "../lib/cards";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName, readingSpec } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { t } from "../i18n";
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
            {sorted.map((c) => (
              <li key={c.id} class="card-list-item">
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
                  {settings.targetLanguages.length > 1 && c.language && (
                    <span class="language-badge">{languageDisplayName(c.language)}</span>
                  )}
                  <button type="button" class="icon-button" onClick={() => deleteCard(c.id)} title={t("cards-delete-title")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
