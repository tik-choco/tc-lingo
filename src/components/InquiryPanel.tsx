import { Check, Circle, Loader2, Square, Volume2 } from "lucide-preact";
import type { ConversationSession, InquiryFact } from "../types";
import type { useSpeech } from "../hooks/useSpeech";
import { summarizeInquiry } from "../lib/inquiry";
import { t } from "../i18n";

type Speech = ReturnType<typeof useSpeech>;

export function InquiryFactAnswer({ fact, language, speech, speakId }: {
  fact: InquiryFact;
  language: string;
  speech: Speech;
  speakId: string;
}) {
  const speaking = speech.speakingId === speakId;
  const loading = speech.loadingId === speakId;
  const speakLabel = speaking ? t("talk-speak-stop") : t("talk-inquiry-speak-answer");
  return (
    <div class="talk-inquiry-answer">
      <span>{fact.detail}</span>
      {speech.supported && (
        <button
          type="button"
          class="speak-button"
          onClick={() => speech.speak(fact.detail, language, speakId)}
          disabled={loading}
          aria-pressed={speaking}
          aria-label={speakLabel}
          title={speakLabel}
        >
          {loading ? <Loader2 size={14} class="speak-button-spin" /> : speaking ? <Square size={14} /> : <Volume2 size={14} />}
        </button>
      )}
    </div>
  );
}

export function InquiryPanel({ session, language, speech }: {
  session: ConversationSession;
  language: string;
  speech: Speech;
}) {
  const { obtained, total } = summarizeInquiry(session);
  const obtainedIds = new Set(obtained.map((fact) => fact.id));
  return (
    <section class="talk-inquiry-panel">
      <div class="talk-inquiry-header">
        <h3>{t("talk-inquiry-mission")}</h3>
        <p class="talk-inquiry-badge" role="status">{t("talk-inquiry-progress", { count: obtained.length, total })}</p>
      </div>
      <p>{session.mission}</p>
      <ul class="talk-inquiry-list">
        {session.facts.map((fact) => {
          const found = obtainedIds.has(fact.id);
          return (
            <li key={fact.id} class="talk-inquiry-check">
              {found ? <Check size={16} class="talk-inquiry-check-mark" aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
              <div>
                <p>{fact.label}</p>
                {found && <InquiryFactAnswer fact={fact} language={language} speech={speech} speakId={`${session.id}-fact-${fact.id}`} />}
              </div>
            </li>
          );
        })}
      </ul>
      {total > 0 && obtained.length === total && <p class="hint-text">{t("talk-inquiry-complete")}</p>}
    </section>
  );
}
