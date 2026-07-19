// App-local settings: which languages the user is studying (possibly several
// at once — see `targetLanguages`/`activeLanguage`), which is their native
// language, the AI Network participation flags, and the per-task LLM
// preset/reasoning-effort overrides (see lib/llmConnection.ts's
// `connectionForTask`). Persisted at tc-lingo:settings-v1 — NOT the shared
// LLM connection details themselves (providers/presets/tts/network.roomId),
// those live in the co-owned tc-shared-llm-config-v1 key (lib/llmConfig.ts).
import type { LingoSettings, LlmConnectionMode, LlmTask, ReasoningEffort } from "../types";
import { loadLlmConfig, saveLlmConfig } from "./llmConfig";
import type { SharedLlmConfigV1 } from "./llmConfig";
import { isNetworkProviderBaseUrl } from "./networkModels";
import { loadJson, saveJson, subscribeStorage } from "./storage";

const STORAGE_NAME = "settings-v1";

// Browser-language → canonical language name (subset of lib/languages.ts
// languageOptions; kept inline to avoid a settings → languages → i18n →
// settings import cycle).
const browserLanguageNames: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  tr: "Turkish",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
};

function detectNativeLanguage(): string {
  const tag = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
  if (tag.startsWith("zh")) {
    return tag.includes("tw") || tag.includes("hk") || tag.includes("hant")
      ? "Chinese (Traditional)"
      : "Chinese (Simplified)";
  }
  return browserLanguageNames[tag.split("-")[0]] ?? "English";
}

/** Fresh-install defaults: the native language follows the browser language
 * (so the app — whose UI language tracks the native language, see
 * i18n/index.ts — is usable worldwide on first launch), and the default study
 * target is English, or Japanese for English natives. No AI Network
 * participation, no per-task overrides, and `reasoning_effort: "none"` sent
 * by default (see types.ts's `ReasoningEffort`). */
function defaultSettings(): LingoSettings {
  const nativeLanguage = detectNativeLanguage();
  const target = nativeLanguage === "English" ? "Japanese" : "English";
  return {
    targetLanguages: [target],
    activeLanguage: target,
    nativeLanguage,
    connectionMode: "api",
    autoExtractCards: true,
    showReadingAids: true,
    networkProviderEnabled: false,
    networkProviderPresetIds: [],
    taskPresetIds: {},
    taskReasoningEfforts: {},
    defaultReasoningEffort: "none",
  };
}

/** Re-points `activeLanguage`/`targetLanguages` at a valid combination
 * (falling back to the default target if the list is somehow empty, or to
 * the first remaining target if `activeLanguage` fell out of the list) —
 * shared by every migration path below so each one doesn't have to repeat
 * the same fixup. */
function withValidLanguages(settings: LingoSettings): LingoSettings {
  if (settings.targetLanguages.length === 0) {
    const fallback = defaultSettings().targetLanguages[0];
    return { ...settings, targetLanguages: [fallback], activeLanguage: fallback };
  }
  if (!settings.targetLanguages.includes(settings.activeLanguage)) {
    return { ...settings, activeLanguage: settings.targetLanguages[0] };
  }
  return settings;
}

function isTaskPresetIds(value: unknown): value is Partial<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function isReasoningEffortValue(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high";
}

function isTaskReasoningEfforts(value: unknown): value is Partial<Record<string, ReasoningEffort>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isReasoningEffortValue);
}

/** Current `LingoSettings` shape (post AI-Network-participation +
 * per-task-preset/reasoning-effort change — see
 * tc-docs/drafts/llm-settings-common-v1.md §2.3/§5). */
function isLingoSettings(value: unknown): value is LingoSettings {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    (r.connectionMode === "api" || r.connectionMode === "network") &&
    typeof r.autoExtractCards === "boolean" &&
    typeof r.showReadingAids === "boolean" &&
    typeof r.networkProviderEnabled === "boolean" &&
    Array.isArray(r.networkProviderPresetIds) &&
    r.networkProviderPresetIds.every((id) => typeof id === "string") &&
    isTaskPresetIds(r.taskPresetIds) &&
    isTaskReasoningEfforts(r.taskReasoningEfforts) &&
    isReasoningEffortValue(r.defaultReasoningEffort)
  );
}

function isTaskModels(value: unknown): value is Partial<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

/** Shape used just before the AI-Network-participation +
 * per-task-preset/reasoning-effort change: a single app-local `presetId` +
 * `ttsEngine`, and `taskModels` (a bare model-name string per task instead of
 * a shared preset id). Migrated in-place on load (see
 * `migrateToTaskPresetIds`): `taskModels`' model names are matched against
 * the shared config's presets (an override is dropped, not guessed at, when
 * no preset uses that exact model — see tc-docs/drafts/llm-settings-common-v1.md
 * §5's porting notes), a non-empty `presetId` seeds the shared config's
 * `defaultPresetId` if that's still empty, and `ttsEngine` is simply
 * dropped — the TTS engine is now always derived from the shared config
 * (see lib/voice.ts's `deriveVoiceEngine`), never stored locally. */
function isPreCommonSettingsShape(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: string;
  autoExtractCards: boolean;
  showReadingAids: boolean;
  taskModels: Partial<Record<string, string>>;
} {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    typeof r.presetId === "string" &&
    (r.connectionMode === "api" || r.connectionMode === "network") &&
    (r.ttsEngine === "browser" || r.ttsEngine === "api" || r.ttsEngine === "network") &&
    typeof r.autoExtractCards === "boolean" &&
    typeof r.showReadingAids === "boolean" &&
    isTaskModels(r.taskModels)
  );
}

/** Pre-task-models shape (same fields as `isPreCommonSettingsShape` minus
 * `taskModels`). Migrated in-place on load — the missing map defaults to `{}`
 * (no per-task overrides) before continuing into `migrateToTaskPresetIds`. */
function isPreTaskModelsSettings(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: string;
  autoExtractCards: boolean;
  showReadingAids: boolean;
} {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    typeof r.presetId === "string" &&
    (r.connectionMode === "api" || r.connectionMode === "network") &&
    (r.ttsEngine === "browser" || r.ttsEngine === "api" || r.ttsEngine === "network") &&
    typeof r.autoExtractCards === "boolean" &&
    typeof r.showReadingAids === "boolean"
  );
}

/** Pre-reading-aid shape (same fields as `isPreTaskModelsSettings` minus
 * `showReadingAids`). Migrated in-place on load — the missing flag defaults
 * to true (reading aids shown) — so existing installs pick the feature up
 * without a reset. */
function isPreReadingAidsSettings(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: string;
  autoExtractCards: boolean;
} {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    typeof r.presetId === "string" &&
    (r.connectionMode === "api" || r.connectionMode === "network") &&
    (r.ttsEngine === "browser" || r.ttsEngine === "api" || r.ttsEngine === "network") &&
    typeof r.autoExtractCards === "boolean"
  );
}

/** Pre-auto-extract shape (same fields as `isPreReadingAidsSettings` minus
 * `autoExtractCards`). Migrated in-place on load — the missing flag defaults
 * to true (auto-extraction on) — so existing installs pick the feature up
 * without a reset. */
function isPreAutoExtractSettings(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: string;
} {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    typeof r.presetId === "string" &&
    (r.connectionMode === "api" || r.connectionMode === "network") &&
    (r.ttsEngine === "browser" || r.ttsEngine === "api" || r.ttsEngine === "network")
  );
}

/** Pre-TTS shape (same fields as `isPreAutoExtractSettings` minus
 * `ttsEngine`). Migrated in-place on load — the (now-unused) engine simply
 * isn't reintroduced, since the TTS engine is always derived, never stored
 * (see `isPreCommonSettingsShape`'s doc comment). */
function isPreTtsEngineSettings(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
} {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    typeof r.presetId === "string" &&
    (r.connectionMode === "api" || r.connectionMode === "network")
  );
}

/** Pre-AI-Network shape (same fields as `isPreTtsEngineSettings` minus
 * `connectionMode`). Migrated in-place on load — missing `connectionMode`
 * defaults to "api" — so existing installs keep behaving as direct API
 * connections instead of silently falling back to the defaults. */
function isPreConnectionModeSettings(
  value: unknown,
): value is { targetLanguages: string[]; activeLanguage: string; nativeLanguage: string; presetId: string } {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.targetLanguages) &&
    r.targetLanguages.every((l) => typeof l === "string") &&
    typeof r.activeLanguage === "string" &&
    typeof r.nativeLanguage === "string" &&
    typeof r.presetId === "string"
  );
}

/** Pre-multi-language shape (a single `targetLanguage: string`). Migrated
 * in-place on load so existing installs keep their language pair instead of
 * silently falling back to the defaults. */
function isLegacySettings(value: unknown): value is { targetLanguage: string; nativeLanguage: string; presetId: string } {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.targetLanguage === "string" && typeof r.nativeLanguage === "string" && typeof r.presetId === "string";
}

/** Finds a shared-config preset whose `model` matches `model` exactly,
 * preferring one backed by a real HTTP provider over one imported from an AI
 * Network room (`mist-network://` pseudo-provider — see networkModels.ts):
 * a legacy per-task model-name override almost always meant "call this exact
 * model at my regular endpoint", and a network-mirrored preset with the same
 * model name could vanish the moment the room's provider un-shares it. */
function findPresetIdForModel(config: SharedLlmConfigV1, model: string): string | undefined {
  const matches = config.presets.filter((p) => p.model === model);
  if (matches.length === 0) return undefined;
  const nonNetwork = matches.find((p) => {
    const provider = config.providers.find((pr) => pr.id === p.providerId);
    return provider !== undefined && !isNetworkProviderBaseUrl(provider.baseUrl);
  });
  return (nonNetwork ?? matches[0]).id;
}

/**
 * Migrates the pre-AI-Network-participation settings shape (see
 * `isPreCommonSettingsShape`) into the current `LingoSettings`:
 * - `taskModels` (a bare model name per task) becomes `taskPresetIds` (a
 *   shared-config preset id per task), via `findPresetIdForModel`. A task
 *   whose model no longer matches any preset is simply dropped (falls back
 *   to the default preset — see lib/llmConfig.ts's `resolvePreset`) rather
 *   than guessed at.
 * - A non-empty legacy `presetId` seeds the shared config's
 *   `defaultPresetId`, but only if that's still empty (append-only —
 *   never overwrites a `defaultPresetId` another app or an earlier install
 *   already set) — and only has an effect once: after the first successful
 *   write `defaultPresetId` is non-empty, so this is a no-op on every
 *   subsequent load even though it re-runs every time (settings migrations
 *   aren't flag-gated, see loadSettings's chain).
 * - `ttsEngine` is dropped (no replacement field - see
 *   `isPreCommonSettingsShape`'s doc comment).
 * - `networkProviderEnabled`/`networkProviderPresetIds` start at their
 *   fresh-install defaults (off / none shared) - there's no prior local
 *   setting to carry forward.
 */
function migrateToTaskPresetIds(pre: {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  autoExtractCards: boolean;
  showReadingAids: boolean;
  taskModels: Partial<Record<string, string>>;
}): LingoSettings {
  const config = loadLlmConfig();

  if (pre.presetId && config && !config.defaultPresetId) {
    saveLlmConfig({ ...config, defaultPresetId: pre.presetId });
  }

  const taskPresetIds: Partial<Record<LlmTask, string>> = {};
  if (config) {
    for (const [task, model] of Object.entries(pre.taskModels)) {
      if (!model) continue;
      const presetId = findPresetIdForModel(config, model);
      if (presetId) taskPresetIds[task as LlmTask] = presetId;
    }
  }

  return {
    targetLanguages: pre.targetLanguages,
    activeLanguage: pre.activeLanguage,
    nativeLanguage: pre.nativeLanguage,
    connectionMode: pre.connectionMode,
    autoExtractCards: pre.autoExtractCards,
    showReadingAids: pre.showReadingAids,
    networkProviderEnabled: false,
    networkProviderPresetIds: [],
    taskPresetIds,
    taskReasoningEfforts: {},
    defaultReasoningEffort: "none",
  };
}

export function loadSettings(): LingoSettings {
  const raw = loadJson<unknown>(STORAGE_NAME, null);
  if (isLingoSettings(raw)) return withValidLanguages(raw);
  if (isPreCommonSettingsShape(raw)) return withValidLanguages(migrateToTaskPresetIds(raw));
  if (isPreTaskModelsSettings(raw)) return withValidLanguages(migrateToTaskPresetIds({ ...raw, taskModels: {} }));
  if (isPreReadingAidsSettings(raw)) {
    return withValidLanguages(migrateToTaskPresetIds({ ...raw, showReadingAids: true, taskModels: {} }));
  }
  if (isPreAutoExtractSettings(raw)) {
    return withValidLanguages(migrateToTaskPresetIds({ ...raw, autoExtractCards: true, showReadingAids: true, taskModels: {} }));
  }
  if (isPreTtsEngineSettings(raw)) {
    return withValidLanguages(migrateToTaskPresetIds({ ...raw, autoExtractCards: true, showReadingAids: true, taskModels: {} }));
  }
  if (isPreConnectionModeSettings(raw)) {
    return withValidLanguages(
      migrateToTaskPresetIds({ ...raw, connectionMode: "api", autoExtractCards: true, showReadingAids: true, taskModels: {} }),
    );
  }
  if (isLegacySettings(raw)) {
    return withValidLanguages(
      migrateToTaskPresetIds({
        targetLanguages: [raw.targetLanguage],
        activeLanguage: raw.targetLanguage,
        nativeLanguage: raw.nativeLanguage,
        presetId: raw.presetId,
        connectionMode: "api",
        autoExtractCards: true,
        showReadingAids: true,
        taskModels: {},
      }),
    );
  }
  return defaultSettings();
}

export function saveSettings(settings: LingoSettings): void {
  saveJson(STORAGE_NAME, settings);
}

export function subscribeSettings(cb: () => void): () => void {
  return subscribeStorage(cb);
}

/** Adds a target language (no-op if already present) and makes it active. */
export function addTargetLanguage(language: string): LingoSettings {
  const trimmed = language.trim();
  const current = loadSettings();
  const next: LingoSettings = current.targetLanguages.includes(trimmed)
    ? { ...current, activeLanguage: trimmed }
    : { ...current, targetLanguages: [...current.targetLanguages, trimmed], activeLanguage: trimmed };
  saveSettings(next);
  return next;
}

/** Removes a target language. Never removes the last one — a learner always
 * has at least one active language. If the removed language was active,
 * falls back to the first remaining one. */
export function removeTargetLanguage(language: string): LingoSettings {
  const current = loadSettings();
  if (current.targetLanguages.length <= 1) return current;
  const targetLanguages = current.targetLanguages.filter((l) => l !== language);
  const activeLanguage = current.activeLanguage === language ? targetLanguages[0] : current.activeLanguage;
  const next: LingoSettings = { ...current, targetLanguages, activeLanguage };
  saveSettings(next);
  return next;
}

/** Switches which target language Practice/Review/Cards/History focus on. */
export function setActiveLanguage(language: string): LingoSettings {
  const current = loadSettings();
  if (!current.targetLanguages.includes(language)) return current;
  const next: LingoSettings = { ...current, activeLanguage: language };
  saveSettings(next);
  return next;
}

/** Switches this app's LLM transport between a direct API preset and the AI
 * Network room (see lib/llmConnection.ts for how this is resolved). */
export function setConnectionMode(mode: LlmConnectionMode): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, connectionMode: mode };
  saveSettings(next);
  return next;
}

/** Toggles background mistake-card auto-extraction (lib/autoExtract.ts). */
export function setAutoExtractCards(enabled: boolean): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, autoExtractCards: enabled };
  saveSettings(next);
  return next;
}

/** Toggles the always-visible reading-aid line (e.g. pinyin — see
 * lib/languages.ts readingAid). Display-only: readings keep being generated
 * and stored while this is off. */
export function setShowReadingAids(enabled: boolean): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, showReadingAids: enabled };
  saveSettings(next);
  return next;
}

/** Toggles this app's participation as an AI Network provider (see
 * hooks/useNetworkProvider.ts). Independent of `connectionMode`. */
export function setNetworkProviderEnabled(enabled: boolean): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, networkProviderEnabled: enabled };
  saveSettings(next);
  return next;
}

/** Replaces the full set of shared-config preset ids this app advertises
 * when acting as an AI Network provider. */
export function setNetworkProviderPresetIds(ids: string[]): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, networkProviderPresetIds: ids };
  saveSettings(next);
  return next;
}

/** Sets (or, with `""`, clears) a per-task preset override. See
 * lib/llmConnection.ts's `connectionForTask`. */
export function setTaskPresetId(task: LlmTask, presetId: string): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, taskPresetIds: { ...current.taskPresetIds, [task]: presetId } };
  saveSettings(next);
  return next;
}

/** Sets a per-task `reasoning_effort` override. See
 * lib/llmConnection.ts's `connectionForTask`. */
export function setTaskReasoningEffort(task: LlmTask, effort: ReasoningEffort): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, taskReasoningEfforts: { ...current.taskReasoningEfforts, [task]: effort } };
  saveSettings(next);
  return next;
}

/** Sets the `reasoning_effort` used for any task without its own override. */
export function setDefaultReasoningEffort(effort: ReasoningEffort): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, defaultReasoningEffort: effort };
  saveSettings(next);
  return next;
}
