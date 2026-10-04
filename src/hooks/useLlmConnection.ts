// Re-resolve the selected task when shared or local settings change.
import { useEffect, useState } from "preact/hooks";
import { resolveLlmConnection, connectionForTask } from "../lib/llmConnection";
import type { LlmConnection } from "../lib/llmConnection";
import type { ResolvedLlmTargetV1, SharedLlmConfigV1 } from "../lib/llmConfig";
import { subscribeLlmConfig } from "../lib/llmConfig";
import { subscribeSettings } from "../lib/settings";

import type { LlmTask } from "../types";

export function useLlmConnection(task?: LlmTask): {
  config: SharedLlmConfigV1 | null;
  target: ResolvedLlmTargetV1 | null;
  mode: "api" | "network";
  roomId: string;
  connection: LlmConnection | null;
} {
  const resolve = () => ({ ...resolveLlmConnection(), ...(task ? { connection: connectionForTask(task) } : {}) });
  const [state, setState] = useState(resolve);

  useEffect(() => {
    function refresh() {
      setState(resolve());
    }
    window.addEventListener("storage", refresh);
    const unsubscribeSettings = subscribeSettings(refresh);
    const unsubscribeConfig = subscribeLlmConfig(refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      unsubscribeSettings();
      unsubscribeConfig();
    };
  }, [task]);

  return state;
}
