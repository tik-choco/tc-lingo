// App-local settings: which languages the user is studying (possibly several
// at once — see `targetLanguages`/`activeLanguage`), which is their native
// language, and which shared LLM preset (see lib/llmConfig.ts) this app
// should use by default. Persisted at tc-lingo:settings-v1 — NOT the shared
// LLM connection details themselves, those live in the co-owned
// tc-shared-llm-config-v1 key.
import type { LingoSettings } from "../types";
import { loadJson, saveJson, subscribeStorage } from "./storage";

const STORAGE_NAME = "settings-v1";

const DEFAULT_SETTINGS: LingoSettings = {
  targetLanguages: ["English"],
  activeLanguage: "English",
  nativeLanguage: "Japanese",
  presetId: "",
};

function isLingoSettings(value: unknown): value is LingoSettings {
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
    if (raw.targetLanguages.length === 0) return { ...raw, targetLanguages: [DEFAULT_SETTINGS.targetLanguages[0]], activeLanguage: DEFAULT_SETTINGS.targetLanguages[0] };
    if (!raw.targetLanguages.includes(raw.activeLanguage)) return { ...raw, activeLanguage: raw.targetLanguages[0] };
    return raw;
  }
  if (isLegacySettings(raw)) {
    return {
      targetLanguages: [raw.targetLanguage],
      activeLanguage: raw.targetLanguage,
      nativeLanguage: raw.nativeLanguage,
      presetId: raw.presetId,
    };
  }
  return DEFAULT_SETTINGS;
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
