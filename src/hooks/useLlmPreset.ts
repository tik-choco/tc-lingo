// Resolves the LLM connection this app should use right now: the shared,
// cross-app config (tc-shared-llm-config-v1) merged with this app's local
// pointer to which preset it wants (settings.presetId, falling back to the
// shared config's own defaultPresetId). Re-resolves on any change to either.
import { useEffect, useState } from "preact/hooks";
import { loadLlmConfig, resolvePreset } from "../lib/llmConfig";
import type { ResolvedLlmTargetV1, SharedLlmConfigV1 } from "../lib/llmConfig";
import { loadSettings, subscribeSettings } from "../lib/settings";

function resolveNow(): { config: SharedLlmConfigV1 | null; target: ResolvedLlmTargetV1 | null } {
  const config = loadLlmConfig();
  if (!config) return { config: null, target: null };
  const presetId = loadSettings().presetId;
  return { config, target: resolvePreset(config, presetId || undefined) };
}

export function useLlmPreset(): { config: SharedLlmConfigV1 | null; target: ResolvedLlmTargetV1 | null } {
  const [state, setState] = useState(resolveNow);

  useEffect(() => {
    function refresh() {
      setState(resolveNow());
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
