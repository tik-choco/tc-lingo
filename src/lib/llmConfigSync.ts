// Same-tab change notification for the shared `tc-shared-llm-config-v1`
// config (lib/llmConfig.ts). That vendored module's own subscribeLlmConfig
// only fires the native `storage` event, which never fires in the tab that
// performed the write - so a same-tab writer that isn't also the reader
// (e.g. hooks/useNetworkModelSync.ts, mirroring AI Network models into the
// config from app.tsx) leaves other same-tab readers (e.g. SettingsView's
// Endpoints/Models display) stuck showing stale state. Same same-tab-
// CustomEvent + cross-tab-storage-event pattern as lib/storage.ts's
// notifyChanged/subscribeStorage.
import { loadLlmConfig, subscribeLlmConfig } from "./llmConfig";
import type { SharedLlmConfigV1 } from "./llmConfig";

const CHANGE_EVENT = "tc-lingo-llm-config-changed";

/** Call after a same-tab `saveLlmConfig()` write that other components need to observe. */
export function notifyLlmConfigChanged(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Subscribes to both same-tab (`notifyLlmConfigChanged`) and cross-tab writes. */
export function subscribeLlmConfigChanges(cb: (config: SharedLlmConfigV1 | null) => void): () => void {
  function onLocal() {
    cb(loadLlmConfig());
  }
  window.addEventListener(CHANGE_EVENT, onLocal);
  const unsubscribeCrossTab = subscribeLlmConfig(cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    unsubscribeCrossTab();
  };
}
