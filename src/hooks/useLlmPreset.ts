// Resolves the shared, cross-app llm config's (tc-shared-llm-config-v1)
// default preset. Re-resolves on any change to it. This app no longer has an
// app-local "which preset do I want" pointer (that was `settings.presetId`,
// removed in favor of per-task overrides — see `LingoSettings.taskPresetIds`
// and lib/llmConnection.ts's `connectionForTask`); this hook is left as a
// thin wrapper over the shared config's own `defaultPresetId` for callers
// that just want "the current default", not a specific task's connection.
import { useEffect, useState } from "preact/hooks";
import { loadLlmConfig, resolvePreset } from "../lib/llmConfig";
import type { ResolvedLlmTargetV1, SharedLlmConfigV1 } from "../lib/llmConfig";
import { subscribeSettings } from "../lib/settings";

function resolveNow(): { config: SharedLlmConfigV1 | null; target: ResolvedLlmTargetV1 | null } {
  const config = loadLlmConfig();
  if (!config) return { config: null, target: null };
  return { config, target: resolvePreset(config) };
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
