// Resolves the LLM connection this app should use right now — a direct API
// preset or the AI Network room, depending on settings.connectionMode (see
// lib/llmConnection.ts) — and re-resolves whenever the shared llm config or
// local settings change. Same storage-event + subscribeSettings pattern as
// useLlmPreset.ts.
import { useEffect, useState } from "preact/hooks";
import { resolveLlmConnection } from "../lib/llmConnection";
import type { LlmConnection } from "../lib/llmConnection";
import type { ResolvedLlmTargetV1, SharedLlmConfigV1 } from "../lib/llmConfig";
import type { LlmConnectionMode } from "../types";
import { subscribeSettings } from "../lib/settings";

export function useLlmConnection(): {
  config: SharedLlmConfigV1 | null;
  target: ResolvedLlmTargetV1 | null;
  mode: LlmConnectionMode;
  roomId: string;
  connection: LlmConnection | null;
} {
  const [state, setState] = useState(resolveLlmConnection);

  useEffect(() => {
    function refresh() {
      setState(resolveLlmConnection());
    }
    window.addEventListener("storage", refresh);
    const unsubscribeSettings = subscribeSettings(refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      unsubscribeSettings();
    };
  }, []);

  return state;
}
