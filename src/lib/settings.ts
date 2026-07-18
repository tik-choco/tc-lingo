// App-local settings: which languages the user is studying (possibly several
// at once — see `targetLanguages`/`activeLanguage`), which is their native
// language, and which shared LLM preset (see lib/llmConfig.ts) this app
// should use by default. Persisted at tc-lingo:settings-v1 — NOT the shared
// LLM connection details themselves, those live in the co-owned
// tc-shared-llm-config-v1 key.
import type { LingoSettings, LlmConnectionMode, TtsEngine } from "../types";
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
 * target is English, or Japanese for English natives. */
function defaultSettings(): LingoSettings {
  const nativeLanguage = detectNativeLanguage();
  const target = nativeLanguage === "English" ? "Japanese" : "English";
  return {
    targetLanguages: [target],
    activeLanguage: target,
    nativeLanguage,
    presetId: "",
    connectionMode: "api",
    ttsEngine: "browser",
    autoExtractCards: true,
    showReadingAids: true,
  };
}

function isLingoSettings(value: unknown): value is LingoSettings {
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

/** Pre-reading-aid shape (same fields as `LingoSettings` minus
 * `showReadingAids`). Migrated in-place on load — the missing flag defaults
 * to true (reading aids shown) — so existing installs pick the feature up
 * without a reset. */
function isPreReadingAidsSettings(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: TtsEngine;
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

/** Pre-auto-extract shape (same fields as `LingoSettings` minus
 * `autoExtractCards`). Migrated in-place on load — the missing flag defaults
 * to true (auto-extraction on) — so existing installs pick the feature up
 * without a reset. */
function isPreAutoExtractSettings(value: unknown): value is {
  targetLanguages: string[];
  activeLanguage: string;
  nativeLanguage: string;
  presetId: string;
  connectionMode: LlmConnectionMode;
  ttsEngine: TtsEngine;
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

/** Pre-TTS shape (same fields as `LingoSettings` minus `ttsEngine`). Migrated
 * in-place on load — missing `ttsEngine` defaults to "browser" — so existing
 * installs keep reading aloud via the Web Speech API instead of silently
 * falling back to the defaults. */
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

/** Pre-AI-Network shape (same fields as `LingoSettings` minus
 * `connectionMode`/`ttsEngine`). Migrated in-place on load — missing
 * `connectionMode` defaults to "api", missing `ttsEngine` defaults to
 * "browser" — so existing installs keep behaving as direct API connections
 * instead of silently falling back to the defaults. */
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

export function loadSettings(): LingoSettings {
  const raw = loadJson<unknown>(STORAGE_NAME, null);
  if (isLingoSettings(raw)) {
    if (raw.targetLanguages.length === 0) {
      const fallback = defaultSettings().targetLanguages[0];
      return { ...raw, targetLanguages: [fallback], activeLanguage: fallback };
    }
    if (!raw.targetLanguages.includes(raw.activeLanguage)) return { ...raw, activeLanguage: raw.targetLanguages[0] };
    return raw;
  }
  if (isPreReadingAidsSettings(raw)) {
    const migrated: LingoSettings = { ...raw, showReadingAids: true };
    if (migrated.targetLanguages.length === 0) {
      const fallback = defaultSettings().targetLanguages[0];
      return { ...migrated, targetLanguages: [fallback], activeLanguage: fallback };
    }
    if (!migrated.targetLanguages.includes(migrated.activeLanguage)) {
      return { ...migrated, activeLanguage: migrated.targetLanguages[0] };
    }
    return migrated;
  }
  if (isPreAutoExtractSettings(raw)) {
    const migrated: LingoSettings = { ...raw, autoExtractCards: true, showReadingAids: true };
    if (migrated.targetLanguages.length === 0) {
      const fallback = defaultSettings().targetLanguages[0];
      return { ...migrated, targetLanguages: [fallback], activeLanguage: fallback };
    }
    if (!migrated.targetLanguages.includes(migrated.activeLanguage)) {
      return { ...migrated, activeLanguage: migrated.targetLanguages[0] };
    }
    return migrated;
  }
  if (isPreTtsEngineSettings(raw)) {
    const migrated: LingoSettings = { ...raw, ttsEngine: "browser", autoExtractCards: true, showReadingAids: true };
    if (migrated.targetLanguages.length === 0) {
      const fallback = defaultSettings().targetLanguages[0];
      return { ...migrated, targetLanguages: [fallback], activeLanguage: fallback };
    }
    if (!migrated.targetLanguages.includes(migrated.activeLanguage)) {
      return { ...migrated, activeLanguage: migrated.targetLanguages[0] };
    }
    return migrated;
  }
  if (isPreConnectionModeSettings(raw)) {
    const migrated: LingoSettings = { ...raw, connectionMode: "api", ttsEngine: "browser", autoExtractCards: true, showReadingAids: true };
    if (migrated.targetLanguages.length === 0) {
      const fallback = defaultSettings().targetLanguages[0];
      return { ...migrated, targetLanguages: [fallback], activeLanguage: fallback };
    }
    if (!migrated.targetLanguages.includes(migrated.activeLanguage)) {
      return { ...migrated, activeLanguage: migrated.targetLanguages[0] };
    }
    return migrated;
  }
  if (isLegacySettings(raw)) {
    return {
      targetLanguages: [raw.targetLanguage],
      activeLanguage: raw.targetLanguage,
      nativeLanguage: raw.nativeLanguage,
      presetId: raw.presetId,
      connectionMode: "api",
      ttsEngine: "browser",
      autoExtractCards: true,
      showReadingAids: true,
    };
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

/** Switches which engine "read this aloud" (hooks/useSpeech.ts) uses. */
export function setTtsEngine(engine: TtsEngine): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, ttsEngine: engine };
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
