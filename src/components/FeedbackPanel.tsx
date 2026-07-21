// Displays one AI feedback round: 原文/修正版/理由/再回答問題 (the four-field
// structured-output format from CLAUDE.md's design brief). Pure display —
// callers own the retry-answer input and any follow-up actions. `language`
// is only used to drive the read-aloud button on the corrected text (see
// hooks/useSpeech.ts) — the panel is otherwise language-agnostic.
import { useEffect, useState } from "preact/hooks";
import { Loader2, Square, Volume2 } from "lucide-preact";
import { diffChars } from "../lib/diff";
import { GrammarExplain } from "./GrammarExplain";
import { useSpeech } from "../hooks/useSpeech";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { t } from "../i18n";

export interface FeedbackPanelProps {
  original: string;
  corrected: string;
  /** Always-visible reading aid for `corrected` (e.g. pinyin — see
   * lib/languages.ts readingAid); "" for languages without one. Optional so
   * existing callers that don't pass it (predating the feature) keep working. */
  correctedReading?: string;
  /** Native-language translation of `corrected`, revealed on demand (same
   * idea as ReadingPassage's per-sentence translation); "" when none. */
  correctedTranslation?: string;
  reasons: string;
  retryPrompt: string;
  /** Reading aid for `retryPrompt`; "" when none. */
  retryPromptReading?: string;
  /** Native-language translation of `retryPrompt`, revealed on demand
   * (same idea as ReadingPassage's per-sentence translation); "" when none. */
  retryPromptTranslation?: string;
  language: string;
  showRetryPrompt?: boolean;
}

/** Gate for the always-visible reading-aid lines below — display-only, see
 * settings.showReadingAids (the reading text itself is always generated and
 * stored regardless of this toggle). */
function useShowReadingAids(): boolean {
  const [show, setShow] = useState(() => loadSettings().showReadingAids);
  useEffect(() => subscribeSettings(() => setShow(loadSettings().showReadingAids)), []);
  return show;
}

export function RetryPromptField({
  retryPrompt,
  retryPromptReading,
  retryPromptTranslation,
  language,
}: {
  retryPrompt: string;
  retryPromptReading?: string;
  retryPromptTranslation?: string;
  language: string;
}) {
  const speech = useSpeech();
  const speakId = "feedback-retry-prompt";
  const speaking = speech.speakingId === speakId;
  const loading = speech.loadingId === speakId;
  const showReadingAids = useShowReadingAids();
  // Self-contained toggle (not lifted to the caller) — every RetryPromptField
  // call site already remounts fresh per attempt/round, same idea as
  // ReadingView's per-sentence reveal but scoped to this one field.
  const [translationRevealed, setTranslationRevealed] = useState(false);

  return (
    <div class="feedback-field">
      <div class="topic-header">
        <h3>{t("practice-feedback-retry-prompt")}</h3>
        {speech.supported && (
          <button
            type="button"
            class="speak-button"
            onClick={() => speech.speak(retryPrompt, language, speakId)}
            disabled={loading}
            aria-pressed={speaking}
            aria-label={speaking ? t("practice-speak-retry-prompt-stop") : t("practice-speak-retry-prompt")}
            title={speaking ? t("practice-speak-retry-prompt-stop") : t("practice-speak-retry-prompt")}
          >
            {loading ? <Loader2 size={14} class="speak-button-spin" /> : speaking ? <Square size={14} /> : <Volume2 size={14} />}
          </button>
        )}
      </div>
      <p class="feedback-retry-prompt">{retryPrompt}</p>
      {showReadingAids && retryPromptReading && <p class="reading-aid">{retryPromptReading}</p>}
      {retryPromptTranslation && (
        <div class="practice-translation-row">
          <button
            type="button"
            class="link-button practice-translation-toggle"
            aria-expanded={translationRevealed}
            onClick={() => setTranslationRevealed((v) => !v)}
          >
            {translationRevealed ? t("practice-translation-hide") : t("practice-translation-show")}
          </button>
          {translationRevealed && <p class="practice-translation">{retryPromptTranslation}</p>}
        </div>
      )}
      {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
    </div>
  );
}

export function FeedbackPanel({
  original,
  corrected,
  correctedReading,
  correctedTranslation,
  reasons,
  retryPrompt,
  retryPromptReading,
  retryPromptTranslation,
  language,
  showRetryPrompt,
}: FeedbackPanelProps) {
  const chunks = diffChars(original, corrected);
  const speech = useSpeech();
  const speakId = "feedback-corrected";
  const speaking = speech.speakingId === speakId;
  const loading = speech.loadingId === speakId;
  const showReadingAids = useShowReadingAids();
  // Self-contained toggle, same rationale as RetryPromptField's — this panel
  // remounts fresh per attempt/round at every call site.
  const [correctedTranslationRevealed, setCorrectedTranslationRevealed] = useState(false);

  return (
    <div class="feedback-panel">
      <div class="feedback-field">
        <h3>{t("practice-feedback-original")}</h3>
        <p class="feedback-original">{original}</p>
      </div>
      <div class="feedback-field">
        <div class="topic-header">
          <h3>{t("practice-feedback-corrected")}</h3>
          {speech.supported && (
            <button
              type="button"
              class="speak-button"
              onClick={() => speech.speak(corrected, language, speakId)}
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
        {showReadingAids && correctedReading && <p class="reading-aid">{correctedReading}</p>}
        {correctedTranslation && (
          <div class="practice-translation-row">
            <button
              type="button"
              class="link-button practice-translation-toggle"
              aria-expanded={correctedTranslationRevealed}
              onClick={() => setCorrectedTranslationRevealed((v) => !v)}
            >
              {correctedTranslationRevealed ? t("practice-translation-hide") : t("practice-translation-show")}
            </button>
            {correctedTranslationRevealed && <p class="practice-translation">{correctedTranslation}</p>}
          </div>
        )}
        <GrammarExplain sentence={corrected} targetLanguage={language} />
      </div>
      <div class="feedback-field">
        <h3>{t("practice-feedback-reasons")}</h3>
        <p class="feedback-reasons">{reasons}</p>
      </div>
      {retryPrompt && showRetryPrompt !== false && (
        <RetryPromptField
          retryPrompt={retryPrompt}
          retryPromptReading={retryPromptReading}
          retryPromptTranslation={retryPromptTranslation}
          language={language}
        />
      )}
      {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
    </div>
  );
}
