import { useEffect, useState } from "preact/hooks";
import { Trash2 } from "lucide-preact";
import { addCard, deleteCard, loadCards, subscribeCards } from "../lib/cards";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName, readingSpec } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import type { Card } from "../types";

function formatDue(dueAt: string): string {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays <= 0) return "復習可";
  if (diffDays === 1) return "明日";
  return `${diffDays}日後`;
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
          <h2>カード({visible.length})</h2>
          <button type="button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "閉じる" : "カードを追加"}
          </button>
        </div>

        {showForm && (
          <form class="field-grid" onSubmit={submit}>
            <label>
              単語・表現
              <input type="text" value={front} onInput={(e) => setFront((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              {readingField.label}(任意)
              <input
                type="text"
                value={reading}
                onInput={(e) => setReading((e.target as HTMLInputElement).value)}
                placeholder={readingField.placeholder}
              />
            </label>
            <label>
              意味
              <input type="text" value={meaning} onInput={(e) => setMeaning((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              例文(任意)
              <input
                type="text"
                value={exampleSentence}
                onInput={(e) => setExampleSentence((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              使う場面(任意)
              <input type="text" value={context} onInput={(e) => setContext((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              穴埋め文(任意, ___で空欄を表す)
              <input type="text" value={cloze} onInput={(e) => setCloze((e.target as HTMLInputElement).value)} />
            </label>
            {settings.targetLanguages.length > 1 && (
              <label>
                言語
                <LanguageSelect value={language} onChange={setLanguage} ariaLabel="カードの言語を選択" />
              </label>
            )}
            <button type="submit" class="primary-button">
              追加
            </button>
          </form>
        )}
      </section>

      <section class="card-panel">
        {sorted.length === 0 ? (
          <p class="hint-text">カードはまだありません。練習タブの「間違いをカード化」か、上のフォームから追加できます。</p>
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
                  <span class={`due-badge${formatDue(c.dueAt) === "復習可" ? " due-badge-ready" : ""}`}>
                    {formatDue(c.dueAt)}
                  </span>
                  {c.source === "mistake" && <span class="source-badge">自分の間違いから</span>}
                  {settings.targetLanguages.length > 1 && c.language && (
                    <span class="language-badge">{languageDisplayName(c.language)}</span>
                  )}
                  <button type="button" class="icon-button" onClick={() => deleteCard(c.id)} title="削除">
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
