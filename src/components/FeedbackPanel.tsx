// Displays one AI feedback round: 原文/修正版/理由/再回答問題 (the four-field
// structured-output format from CLAUDE.md's design brief). Pure display —
// callers own the retry-answer input and any follow-up actions.
import { diffChars } from "../lib/diff";
import { t } from "../i18n";

export interface FeedbackPanelProps {
  original: string;
  corrected: string;
  reasons: string;
  retryPrompt: string;
}

export function FeedbackPanel({ original, corrected, reasons, retryPrompt }: FeedbackPanelProps) {
  const chunks = diffChars(original, corrected);

  return (
    <div class="feedback-panel">
      <div class="feedback-field">
        <h3>{t("practice-feedback-original")}</h3>
        <p class="feedback-original">{original}</p>
      </div>
      <div class="feedback-field">
        <h3>{t("practice-feedback-corrected")}</h3>
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
          <h3>{t("practice-feedback-retry-prompt")}</h3>
          <p class="feedback-retry-prompt">{retryPrompt}</p>
        </div>
      )}
    </div>
  );
}
