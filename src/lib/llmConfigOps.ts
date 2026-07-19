// User-initiated edit/delete operations on the shared LLM connection config
// (tc-shared-llm-config-v1). lib/llmConfig.ts is a vendored contract file
// shared byte-for-byte across the tik-choco app family and is deliberately
// append-only (`ensureProvider`/`ensurePreset` only ever push new entries,
// never mutate or remove existing ones) — that file must not be hand-edited.
// This module lives outside the vendored contract and covers the operations
// only this app's settings UI needs: a user explicitly renaming/reconnecting
// a provider ("接続先") or preset ("モデル"), or deleting one, mirroring
// tc-pdf-viewer's SettingsPanel service layer (updateLlmProvider/
// removeLlmProvider/etc.) for the same shared config shape.
import { emptyLlmConfig, ensurePreset, ensureProvider, loadLlmConfig, normalizeBaseUrl, saveLlmConfig } from "./llmConfig";
import type { SharedLlmConfigV1 } from "./llmConfig";

/**
 * After any provider/preset removal: if `defaultPresetId` no longer points
 * at an existing preset, reassign it to the first remaining preset (or ""
 * if none remain). This app's per-task preset overrides
 * (`LingoSettings.taskPresetIds`, see lib/settings.ts) need no equivalent
 * cleanup: `resolvePreset` (lib/llmConfig.ts) already falls back to the
 * default preset whenever a stored id doesn't resolve, so a dangling
 * `taskPresetIds` entry degrades gracefully on its own. Mutates `config` in
 * place; does not itself call saveLlmConfig.
 */
function cleanupDanglingReferences(config: SharedLlmConfigV1): void {
  if (config.defaultPresetId && !config.presets.some((p) => p.id === config.defaultPresetId)) {
    config.defaultPresetId = config.presets[0]?.id ?? "";
  }
}

/**
 * Sets the shared config's default preset id directly (used by the Tasks
 * tab's 既定 row select) — unlike `addPreset`'s "becomes the default only if
 * none is set yet" behavior, this always overwrites. A value that isn't ""
 * and doesn't match an existing preset is ignored (e.g. a stale id from a
 * preset removed in another tab between render and this call).
 */
export function setDefaultPresetId(id: string): SharedLlmConfigV1 {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  if (id === "" || config.presets.some((p) => p.id === id)) {
    config.defaultPresetId = id;
    saveLlmConfig(config);
  }
  return config;
}

/** Finds-or-creates a provider (see `ensureProvider`) and persists the config. */
export function addProvider(input: {
  label?: string;
  baseUrl: string;
  apiKey: string;
}): { config: SharedLlmConfigV1; providerId: string } {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  const providerId = ensureProvider(config, input);
  saveLlmConfig(config);
  return { config, providerId };
}

/**
 * Applies a partial edit to an existing provider. `baseUrl` is normalized
 * (an empty-after-trim value is ignored, leaving the existing baseUrl
 * untouched); an empty `label` is allowed (the UI falls back to a host
 * display for a blank label). Unknown `id` is a no-op — the loaded config is
 * returned without being re-saved.
 */
export function updateProvider(
  id: string,
  patch: { label?: string; baseUrl?: string; apiKey?: string },
): SharedLlmConfigV1 {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) return config;

  if (patch.label !== undefined) provider.label = patch.label;
  if (patch.baseUrl !== undefined) {
    const normalized = normalizeBaseUrl(patch.baseUrl);
    if (normalized) provider.baseUrl = normalized;
  }
  if (patch.apiKey !== undefined) provider.apiKey = patch.apiKey;

  saveLlmConfig(config);
  return config;
}

/**
 * Removes a provider and cascade-removes every preset that referenced it
 * (a preset can't resolve without its provider — see `resolvePreset`), then
 * cleans up any now-dangling `defaultPresetId`/`settings.presetId`
 * references.
 */
export function removeProvider(id: string): SharedLlmConfigV1 {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  config.providers = config.providers.filter((p) => p.id !== id);
  config.presets = config.presets.filter((p) => p.providerId !== id);

  cleanupDanglingReferences(config);
  saveLlmConfig(config);
  return config;
}

/**
 * Finds-or-creates a preset (see `ensurePreset`) and persists the config.
 * If no default preset is set yet, the new preset becomes the default.
 */
export function addPreset(input: {
  label?: string;
  providerId: string;
  model: string;
}): { config: SharedLlmConfigV1; presetId: string } {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  const presetId = ensurePreset(config, input);
  if (!config.defaultPresetId) config.defaultPresetId = presetId;
  saveLlmConfig(config);
  return { config, presetId };
}

/**
 * Applies a partial edit to an existing preset. An empty-after-trim `model`
 * patch is ignored; a `providerId` patch that doesn't reference an existing
 * provider is ignored; an empty `label` patch keeps the existing label
 * (unlike `updateProvider`, presets always show a label — see
 * `ensurePreset`'s `input.label || input.model` fallback on creation).
 * Unknown `id` is a no-op.
 */
export function updatePreset(
  id: string,
  patch: { label?: string; providerId?: string; model?: string },
): SharedLlmConfigV1 {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  const preset = config.presets.find((p) => p.id === id);
  if (!preset) return config;

  if (patch.label !== undefined && patch.label.trim()) preset.label = patch.label;
  if (patch.providerId !== undefined && config.providers.some((p) => p.id === patch.providerId)) {
    preset.providerId = patch.providerId;
  }
  if (patch.model !== undefined && patch.model.trim()) preset.model = patch.model;

  saveLlmConfig(config);
  return config;
}

/**
 * Removes a preset, then cleans up any now-dangling
 * `defaultPresetId`/`settings.presetId` references.
 */
export function removePreset(id: string): SharedLlmConfigV1 {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  config.presets = config.presets.filter((p) => p.id !== id);

  cleanupDanglingReferences(config);
  saveLlmConfig(config);
  return config;
}
