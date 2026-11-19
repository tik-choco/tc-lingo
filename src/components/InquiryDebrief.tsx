import { useEffect, useRef } from "preact/hooks";
import { RotateCcw } from "lucide-preact";
import type { ConversationSession } from "../types";
import type { useSpeech } from "../hooks/useSpeech";
import { summarizeInquiry } from "../lib/inquiry";
import { t } from "../i18n";
import { InquiryFactAnswer } from "./InquiryPanel";

export function InquiryDebrief({ session, previous, language, speech, onRetry }: {
  session: ConversationSession;
  previous?: ConversationSession;
  language: string;
  speech: ReturnType<typeof useSpeech>;
  onRetry: () => void;
}) {
  const { total, obtained, missed, clarificationCount, unclearTurns } = summarizeInquiry(session);
  const previousSummary = previous ? summarizeInquiry(previous) : undefined;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [session.id]);

  return (
    <section class="talk-inquiry-panel">
      <h3 ref={headingRef} tabIndex={-1}>{t("talk-inquiry-debrief")}</h3>
      <div class="talk-inquiry-stats">
        <span class="talk-inquiry-badge">{t("talk-inquiry-progress", { count: obtained.length, total })}</span>
        <span class="talk-inquiry-badge">{t("talk-inquiry-clarification-count", { count: clarificationCount })}</span>
      </div>
      {previousSummary && (
        <p class="hint-text">
          {t("talk-inquiry-previous", {
            count: previousSummary.obtained.length, total: previousSummary.total, clarifications: previousSummary.clarificationCount,
          })}
        </p>
      )}
      {([
        { heading: "talk-inquiry-obtained", facts: obtained },
        { heading: "talk-inquiry-missed", facts: missed },
      ] as const).map(({ heading, facts }) => facts.length > 0 && (
        <div key={heading}>
          <h4>{t(heading)}</h4>
          <ul class="talk-inquiry-list">
            {facts.map((fact) => (
              <li key={fact.id}>
                <p>{fact.label}</p>
                <InquiryFactAnswer fact={fact} language={language} speech={speech} speakId={`${session.id}-fact-${fact.id}`} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {unclearTurns.length > 0 && (
        <div>
          <h4>{t("talk-inquiry-unclear-turns")}</h4>
          <ul class="talk-inquiry-list talk-inquiry-review">
            {unclearTurns.map((turn) => (
              <li key={turn.id}>
                <dl>
                  <dt>{t("talk-inquiry-original")}</dt>
                  <dd>{turn.text}</dd>
                  {turn.corrected && <><dt>{t("talk-inquiry-corrected")}</dt><dd>{turn.corrected}</dd></>}
                </dl>
                {turn.unclearReason && <p class="hint-text">{turn.unclearReason}</p>}
                {turn.reasons && <p class="hint-text">{turn.reasons}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div class="button-row">
        <button type="button" onClick={onRetry}>
          <RotateCcw size={16} aria-hidden="true" />
          {t("talk-inquiry-retry")}
        </button>
      </div>
    </section>
  );
}
