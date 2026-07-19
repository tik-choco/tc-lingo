// On-demand grammar breakdown for one target-language sentence — closes the
// 理解 step of CLAUDE.md's core loop that the rest of the app never handles
// explicitly (it corrects output but doesn't proactively explain structure).
// Self-contained: resolves the LLM connection and native language itself so
// call sites (FeedbackPanel, ReviewView) stay one-liners. Renders nothing
// when there's no sentence or no configured connection, so callers never
// need to guard around it.
import { useEffect, useState } from "preact/hooks";
import { BookOpenCheck, ChevronUp, Loader2 } from "lucide-preact";
import type { GrammarPoint } from "../lib/grammar";
import { requestGrammarExplanation } from "../lib/grammar";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { connectionForTask } from "../lib/llmConnection";
import { loadSettings } from "../lib/settings";
import { localizeNetworkError } from "../lib/network";
import { t } from "../i18n";
import "../styles/grammar.css";

export interface GrammarExplainProps {
  sentence: string;
  targetLanguage: string;
}

type FetchState = "idle" | "loading" | "loaded" | "error";

export function GrammarExplain({ sentence, targetLanguage }: GrammarExplainProps) {
  const { connection } = useLlmConnection();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<FetchState>("idle");
  const [points, setPoints] = useState<GrammarPoint[]>([]);
  const [error, setError] = useState("");

  // Re-collapse and drop any fetched result whenever the underlying sentence
  // changes (e.g. the reviewed card advances, or a fresh correction lands)
  // so a stale explanation never lingers under a new sentence.
  useEffect(() => {
    setExpanded(false);
    setState("idle");
    setPoints([]);
    setError("");
  }, [sentence]);

  // Hooks above must always run in the same order, so the early-out lives
  // after them rather than short-circuiting the component entirely.
  if (!sentence.trim() || !connection) return null;

  async function fetchExplanation() {
    if (!connection) return;
    const conn = connectionForTask("grammar");
    if (!conn) return;
    setState("loading");
    setError("");
    try {
      const nativeLanguage = loadSettings().nativeLanguage;
      const result = await requestGrammarExplanation({
        connection: conn,
        targetLanguage,
        nativeLanguage,
        sentence: sentence.trim(),
      });
      setPoints(result);
      setState("loaded");
    } catch (err) {
      setError(localizeNetworkError(err, t("grammar-error-generic")));
      setState("error");
    }
  }

  function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (state === "idle") void fetchExplanation();
  }

  const loading = state === "loading";

  return (
    <div class="grammar-explain">
      <button
        type="button"
        class="link-button grammar-explain-toggle"
        onClick={toggle}
        disabled={loading}
        aria-expanded={expanded}
      >
        {loading ? (
          <Loader2 size={14} class="speak-button-spin" />
        ) : expanded ? (
          <ChevronUp size={14} />
        ) : (
          <BookOpenCheck size={14} />
        )}
        {expanded ? t("grammar-collapse-button") : t("grammar-explain-button")}
      </button>
      {expanded && (
        <div class="grammar-explain-panel">
          {loading && <p class="hint-text">{t("grammar-loading")}</p>}
          {state === "error" && (
            <div class="grammar-explain-error">
              <p class="error-text">{error}</p>
              <button type="button" class="link-button" onClick={fetchExplanation}>
                {t("grammar-retry-button")}
              </button>
            </div>
          )}
          {state === "loaded" && points.length === 0 && <p class="hint-text">{t("grammar-empty-state")}</p>}
          {state === "loaded" && points.length > 0 && (
            <ul class="grammar-points">
              {points.map((point, i) => (
                <li key={i} class="grammar-point">
                  <p class="grammar-point-pattern">{point.pattern}</p>
                  <p class="grammar-point-explanation">{point.explanation}</p>
                  <p class="grammar-point-example">
                    <span class="grammar-point-example-label">{t("grammar-example-label")}</span>
                    {point.example}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
