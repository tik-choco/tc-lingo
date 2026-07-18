// Displays one AI feedback round: 原文/修正版/理由/再回答問題 (the four-field
// structured-output format from CLAUDE.md's design brief). Pure display —
// callers own the retry-answer input and any follow-up actions. `language`
// is only used to drive the read-aloud button on the corrected text (see
// hooks/useSpeech.ts) — the panel is otherwise language-agnostic.
import { Loader2, Square, Volume2 } from "lucide-preact";
import { diffChars } from "../lib/diff";
import { useSpeech } from "../hooks/useSpeech";
import { t } from "../i18n";

export interface FeedbackPanelProps {
  original: string;
  corrected: string;
  reasons: string;
  retryPrompt: string;
  language: string;
}

export function FeedbackPanel({ original, corrected, reasons, retryPrompt, language }: FeedbackPanelProps) {
  const chunks = diffChars(original, corrected);
  const speech = useSpeech();
  const speakId = "feedback-corrected";
  const speaking = speech.speakingId === speakId;
  const loading = speech.loadingId === speakId;
  const retryPromptSpeakId = "feedback-retry-prompt";
  const retryPromptSpeaking = speech.speakingId === retryPromptSpeakId;
  const retryPromptLoading = speech.loadingId === retryPromptSpeakId;

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
      </div>
      <div class="feedback-field">
        <h3>{t("practice-feedback-reasons")}</h3>
        <p class="feedback-reasons">{reasons}</p>
      </div>
      {retryPrompt && (
        <div class="feedback-field">
          <div class="topic-header">
            <h3>{t("practice-feedback-retry-prompt")}</h3>
            {speech.supported && (
              <button
                type="button"
                class="speak-button"
                onClick={() => speech.speak(retryPrompt, language, retryPromptSpeakId)}
                disabled={retryPromptLoading}
                aria-pressed={retryPromptSpeaking}
                aria-label={retryPromptSpeaking ? t("practice-speak-retry-prompt-stop") : t("practice-speak-retry-prompt")}
                title={retryPromptSpeaking ? t("practice-speak-retry-prompt-stop") : t("practice-speak-retry-prompt")}
              >
                {retryPromptLoading ? (
                  <Loader2 size={14} class="speak-button-spin" />
                ) : retryPromptSpeaking ? (
                  <Square size={14} />
                ) : (
                  <Volume2 size={14} />
                )}
              </button>
            )}
          </div>
          <p class="feedback-retry-prompt">{retryPrompt}</p>
        </div>
      )}
      {speech.speechError && <p class="speak-error">{speech.speechError}</p>}
    </div>
  );
}
