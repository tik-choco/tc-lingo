// Same-topic repeated practice, made visible: for each topic, shows every
// recorded round (初回/改善版/翌日再挑戦) plus a diff between the previous
// round's corrected text and this round's fresh attempt — "did I actually
// incorporate last time's feedback, unprompted?" is the whole point of the
// three-round design (see CLAUDE.md).
import { useEffect, useState } from "preact/hooks";
import { attemptsForTopic, deleteTopic, loadTopics, subscribeTopics } from "../lib/topics";
import type { Topic } from "../types";
import { diffChars } from "../lib/diff";
import { FeedbackPanel } from "../components/FeedbackPanel";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { t, getUiLanguage } from "../i18n";

function formatAttemptDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(getUiLanguage());
}

function DiffLine({ before, after }: { before: string; after: string }) {
  const chunks = diffChars(before, after);
  return (
    <p class="feedback-diff">
      {chunks.map((chunk, i) => (
        <span key={i} class={chunk.op === "same" ? undefined : `diff-${chunk.op}`}>
          {chunk.text}
        </span>
      ))}
    </p>
  );
}

export function HistoryView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  const [topics, setTopics] = useState<Topic[]>(() => loadTopics(settings.activeLanguage));
  useEffect(() => subscribeTopics(() => setTopics(loadTopics(loadSettings().activeLanguage))), []);
  useEffect(() => {
    setTopics(loadTopics(settings.activeLanguage));
  }, [settings.activeLanguage]);

  const [openTopicId, setOpenTopicId] = useState<string | null>(null);

  if (topics.length === 0) {
    return (
      <div class="view-container history-view">
        <section class="card-panel">
          <p class="hint-text">{t("history-empty-state")}</p>
        </section>
      </div>
    );
  }

  return (
    <div class="view-container history-view">
      {topics.map((topic) => {
        const attempts = attemptsForTopic(topic.id);
        const open = openTopicId === topic.id;
        const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
        return (
          <section class="card-panel" key={topic.id}>
            <div class="topic-header">
              <button
                type="button"
                class="link-button history-topic-toggle"
                aria-expanded={open}
                onClick={() => setOpenTopicId(open ? null : topic.id)}
              >
                {topic.title}
              </button>
              <div class="button-row">
                {settings.targetLanguages.length > 1 && topic.language && (
                  <span class="language-badge">{languageDisplayName(topic.language)}</span>
                )}
                {lastAttempt && (
                  <span class="history-last-practiced hint-text">
                    {t("history-last-practiced", { date: formatAttemptDate(lastAttempt.createdAt) })}
                  </span>
                )}
                <span class="round-badge">{attempts.length}/3</span>
                <button
                  type="button"
                  class="icon-button"
                  title={t("history-delete-topic")}
                  aria-label={t("history-delete-topic")}
                  onClick={() => {
                    if (openTopicId === topic.id) setOpenTopicId(null);
                    deleteTopic(topic.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {open && (
              <div class="history-detail">
                <p class="topic-prompt">{topic.prompt}</p>
                {attempts.map((attempt, i) => {
                  const prev = i > 0 ? attempts[i - 1] : null;
                  return (
                    <div class="history-round" key={attempt.id}>
                      <div class="history-round-header">
                        <h3>{t("history-round-label", { round: attempt.round })}</h3>
                        <span class="history-round-date hint-text">{formatAttemptDate(attempt.createdAt)}</span>
                      </div>
                      {prev && (
                        <div class="feedback-field">
                          <h4>{t("history-diff-heading")}</h4>
                          <DiffLine before={prev.corrected} after={attempt.original} />
                        </div>
                      )}
                      {/* retryPrompt is deliberately blanked here: the Q&A block
                          below owns the follow-up question so it isn't shown twice. */}
                      <FeedbackPanel
                        original={attempt.original}
                        corrected={attempt.corrected}
                        reasons={attempt.reasons}
                        retryPrompt=""
                      />
                      {attempt.retryPrompt && (
                        <div class="feedback-field history-retry-qa">
                          <h4>{t("practice-feedback-retry-prompt")}</h4>
                          <p class="feedback-retry-prompt">{attempt.retryPrompt}</p>
                          <h4>{t("history-retry-answer-heading")}</h4>
                          {attempt.retryAnswer ? (
                            <p class="feedback-original">{attempt.retryAnswer}</p>
                          ) : (
                            <p class="hint-text">{t("history-retry-not-answered")}</p>
                          )}
                          {attempt.retryCorrected && (
                            <>
                              <h4>{t("practice-feedback-corrected")}</h4>
                              <DiffLine before={attempt.retryAnswer} after={attempt.retryCorrected} />
                              {attempt.retryReasons && (
                                <>
                                  <h4>{t("practice-feedback-reasons")}</h4>
                                  <p class="feedback-reasons">{attempt.retryReasons}</p>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
