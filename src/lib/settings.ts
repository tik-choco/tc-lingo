import type { LingoSettings, LlmTask, LlmTaskGroup, ReasoningEffort } from "../types";
import type { LlmLocalSettings, TaskModelV1 } from "@tik-choco/mistai/preact";
import { normalizeLeaderboardName } from "./leaderboard/protocol";
import { loadLlmConfig, emptyLlmConfig, presetIdToRef, providerKind, roomIdFromBaseUrl, isModelRef, setDefaultModel, saveLlmConfig } from "./llmConfig";
import { loadJson, saveJson, subscribeStorage } from "./storage";

const STORAGE_NAME = "settings-v1";
export const REVIEW_LIMITS = {
  reviewSessionLimit: { min: 5, max: 200, fallback: 40 },
  newCardsPerDay: { min: 0, max: 100, fallback: 10 },
} as const;

export function normalizeReviewLimit(field: keyof typeof REVIEW_LIMITS, value: unknown): number {
  const { min, max, fallback } = REVIEW_LIMITS[field];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

// Members are listed in migration priority order.
const TASKS: Record<LlmTaskGroup, readonly Exclude<LlmTask, "decision">[]> = {
  correction: ["practice", "review", "conversation", "assistant"],
  generation: ["cards", "topic", "reading", "grammar", "ui-translation"],
  "card-organize": ["card-organize"],
};
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


function effort(value: unknown): ReasoningEffort | undefined {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string) ? value as ReasoningEffort : undefined;
}

export function voiceRefKey(ref: { providerId: string; model: string }): string {
  return JSON.stringify([ref.providerId, ref.model]);
}

export function loadSettings(): LingoSettings {
  const raw = loadJson<Record<string, any>>(STORAGE_NAME, {}) ?? {};
  const nativeLanguage = typeof raw.nativeLanguage === "string" ? raw.nativeLanguage : detectNativeLanguage();
  const fallback = nativeLanguage === "English" ? "Japanese" : "English";
  const targetLanguages = Array.isArray(raw.targetLanguages) ? raw.targetLanguages.filter((v: unknown) => typeof v === "string") :
    typeof raw.targetLanguage === "string" ? [raw.targetLanguage] : [fallback];
  if (!targetLanguages.length) targetLanguages.push(fallback);
  const base = {
    targetLanguages, activeLanguage: targetLanguages.includes(raw.activeLanguage) ? raw.activeLanguage : targetLanguages[0],
    nativeLanguage, autoExtractCards: raw.autoExtractCards !== false, showReadingAids: raw.showReadingAids !== false,
    autoOrganizeCards: raw.autoOrganizeCards !== false, lastCardAutoOrganizeAt: typeof raw.lastCardAutoOrganizeAt === "string" ? raw.lastCardAutoOrganizeAt : "",
    reviewSessionLimit: normalizeReviewLimit("reviewSessionLimit", raw.reviewSessionLimit),
    newCardsPerDay: normalizeReviewLimit("newCardsPerDay", raw.newCardsPerDay),
    leaderboardEnabled: raw.leaderboardEnabled === true,
    didAutoSync: raw.didAutoSync !== false,
    leaderboardName: normalizeLeaderboardName(raw.leaderboardName),
    ttsVoicesByRef: raw.ttsVoicesByRef ?? {},
  };
  if (raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
    const storedTasks: LlmLocalSettings["tasks"] = raw.tasks;
    const tasks = { ...storedTasks };
    let changed = false;
    for (const [group, members] of Object.entries(TASKS)) {
      if (group === "card-organize") continue;
      if (!Object.hasOwn(tasks, group)) {
        const first = members.find(id => storedTasks[id] !== undefined);
        if (first) tasks[group] = storedTasks[first];
      }
      for (const id of members) {
        if (Object.hasOwn(tasks, id)) {
          delete tasks[id];
          changed = true;
        }
      }
    }
    if (changed) saveJson(STORAGE_NAME, { ...raw, tasks });
    return { ...base, tasks, roomProvide: raw.roomProvide ?? {}, recentModels: Array.isArray(raw.recentModels) ? raw.recentModels.filter(isModelRef).slice(0, 8) : [] };
  }
  const config = loadLlmConfig() ?? emptyLlmConfig();
  if (!config.defaultModel && typeof raw.presetId === "string") {
    const ref = presetIdToRef(config, raw.presetId);
    if (ref) { setDefaultModel(config, ref); saveLlmConfig(config); }
  }
  const tasks: Record<string, TaskModelV1> = {};
  for (const [group, members] of Object.entries(TASKS)) {
    const id = members.find(id => typeof raw.taskPresetIds?.[id] === "string" ||
      typeof raw.taskModels?.[id] === "string" || effort(raw.taskReasoningEfforts?.[id]) !== undefined) ?? group;
    const presetId = raw.taskPresetIds?.[id] ?? raw.taskPresetIds?.[group] ?? raw.presetId;
    const preset = config.presets.find(p => p.id === presetId);
    let ref = presetId ? presetIdToRef(config, presetId) : undefined;
    if (!ref && typeof raw.taskModels?.[id] === "string") {
      const old = config.presets.find(p => p.model === raw.taskModels[id] && config.providers.some(pr => pr.id === p.providerId && providerKind(pr) === "http"));
      if (old) ref = presetIdToRef(config, old.id);
    }
    const reasoningEffort = group === "card-organize" ? "none" :
      effort(raw.taskReasoningEfforts?.[id]) ?? effort(raw.taskReasoningEfforts?.[group]) ?? effort(preset?.reasoningEffort) ?? effort(raw.defaultReasoningEffort) ?? "none";
    tasks[group] = { ...(ref ? { ref } : {}), reasoningEffort };
  }
  const room = config.providers.find(p => providerKind(p) === "room" && roomIdFromBaseUrl(p.baseUrl) === config.network.roomId.trim());
  const sharedPresetIds = Array.isArray(raw.networkProviderPresetIds) ? raw.networkProviderPresetIds : [];
  const shared = sharedPresetIds.map((id: string) => presetIdToRef(config, id)).filter(isModelRef)
    .filter(ref => config.providers.some(p => p.id === ref.providerId && providerKind(p) === "http"));
  const voiceProviderId = config.tts?.providerId ?? config.defaultModel?.providerId;
  const voiceRef = config.tts && voiceProviderId ? { providerId: voiceProviderId, model: config.tts.model } : undefined;
  const next: LingoSettings = { ...base, tasks, roomProvide: room ? { [room.id]: { enabled: raw.networkProviderEnabled === true, shared } } : {}, recentModels: [] };
  if (voiceRef && raw.ttsVoiceByLanguage) {
    next.ttsVoicesByRef = { ...next.ttsVoicesByRef, [voiceRefKey(voiceRef)]: { ...raw.ttsVoiceByLanguage } };
  }
  // Persist before consumers subscribe; raw migration fields are no longer app-local settings.
  saveJson(STORAGE_NAME, next);
  return next;
}

export function saveSettings(settings: LingoSettings): void { saveJson(STORAGE_NAME, settings); }
export function subscribeSettings(cb: () => void): () => void { return subscribeStorage(cb); }
export const llmLocalAdapter = {
  get: (): LlmLocalSettings => { const { tasks, roomProvide, recentModels } = loadSettings(); return { tasks, roomProvide, recentModels }; },
  set: (next: LlmLocalSettings) => saveSettings({ ...loadSettings(), ...next }),
  subscribe: subscribeSettings,
};

export function setTtsVoiceOverride(ref: { providerId: string; model: string }, subtag: string, voice: string): void {
  const current = loadSettings();
  const key = voiceRefKey(ref);
  const map = { ...current.ttsVoicesByRef[key] };
  if (voice.trim()) map[subtag] = voice.trim(); else delete map[subtag];
  saveSettings({ ...current, ttsVoicesByRef: { ...current.ttsVoicesByRef, [key]: map } });
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

/** Toggles lib/cardAutoOrganize.ts's silent background merge pass. */
export function setAutoOrganizeCards(enabled: boolean): LingoSettings {
  const current = loadSettings();
  const next: LingoSettings = { ...current, autoOrganizeCards: enabled };
  saveSettings(next);
  return next;
}

/** Internal bookkeeping for lib/cardAutoOrganize.ts's cooldown check — not
 * meant to be called from the UI. */
export function markCardAutoOrganizeRan(at: string): void {
  const current = loadSettings();
  saveSettings({ ...current, lastCardAutoOrganizeAt: at });
}
