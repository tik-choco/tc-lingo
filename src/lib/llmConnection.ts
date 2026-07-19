// Resolves which LLM transport this app should actually use right now: a
// direct API preset from the shared llm config (lib/llmConfig.ts), or the
// P2P AI Network room (mistllm-wire v1) recorded at
// `llmConfig.network.roomId`. Which one is "current" is a local choice
// (settings.connectionMode); the room id itself is shared/co-owned, same as
// providers/presets — see llmConfig.ts's merge policy comment.
import { emptyLlmConfig, loadLlmConfig, resolvePreset, saveLlmConfig } from "./llmConfig";
import type { ResolvedLlmTargetV1, SharedLlmConfigV1 } from "./llmConfig";
import { isNetworkProviderBaseUrl } from "./networkModels";
import { loadSettings } from "./settings";
import type { LlmConnectionMode, LlmTask, ReasoningEffort } from "../types";

/** The transport a caller should actually use. Distinct from `target`/`roomId`
 * alone in `resolveLlmConnection`'s return value: those report what each
 * transport resolves to independent of `mode`, while `connection` is null
 * whenever the currently selected mode isn't configured yet (no preset for
 * "api", no room id for "network") — callers should gate on `connection`,
 * not on `target`/`roomId` directly. The network variant's `model` is only
 * ever set by `connectionForTask` below, for a task whose resolved preset
 * itself points at a `mist-network://` pseudo-provider — the room's
 * provider echoes it back as the advertised name (see networkModels.ts's
 * `advertisedModelName`) to pick the matching upstream preset. Omitted
 * (`undefined`) means "let the room's provider use its own default", the
 * behavior for the plain "use the AI Network" global toggle. */
export type LlmConnection =
  | { kind: "api"; target: ResolvedLlmTargetV1 }
  | { kind: "network"; roomId: string; model?: string };

export function resolveLlmConnection(): {
  config: SharedLlmConfigV1 | null;
  /** The resolved default preset, regardless of `mode` — present whenever a
   * default preset is configured, even if `mode` is currently "network". */
  target: ResolvedLlmTargetV1 | null;
  mode: LlmConnectionMode;
  /** The shared AI Network room id, regardless of `mode`. "" if unset. */
  roomId: string;
  connection: LlmConnection | null;
} {
  const config = loadLlmConfig();
  const settings = loadSettings();
  const target = config ? resolvePreset(config) : null;
  const mode = settings.connectionMode;
  const roomId = config?.network.roomId ?? "";
  const connection: LlmConnection | null =
    mode === "network" ? (roomId ? { kind: "network", roomId } : null) : target ? { kind: "api", target } : null;
  return { config, target, mode, roomId, connection };
}

/** Updates the shared config's default AI Network room id in place. Seeds a
 * fresh `emptyLlmConfig()` if this app is the first in the origin to write
 * the shared config — never overwrites another app's providers/presets. */
export function setSharedNetworkRoomId(roomId: string): void {
  const config = loadLlmConfig() ?? emptyLlmConfig();
  config.network = { roomId: roomId.trim() };
  saveLlmConfig(config);
}

/** UI display order for the per-task preset/reasoning-effort override list
 * (see SettingsView / `LingoSettings.taskPresetIds`/`taskReasoningEfforts`). */
export const LLM_TASKS: readonly LlmTask[] = [
  "practice",
  "topic",
  "cards",
  "review",
  "reading",
  "conversation",
  "grammar",
  "ui-translation",
];

/**
 * Resolves the actual connection an LLM call for `task` should use, folding
 * in this app's per-task overrides (`LingoSettings.taskPresetIds`/
 * `taskReasoningEfforts`, see lib/settings.ts) on top of the shared llm
 * config (lib/llmConfig.ts) and the global `connectionMode` toggle:
 *
 * 1. Resolve the task's preset id (`taskPresetIds[task]`, "" falling back to
 *    the shared config's own `defaultPresetId` — see `resolvePreset`'s own
 *    fallback, so a stale/removed override id degrades the same way).
 * 2. If that preset's provider is a `mist-network://` pseudo-provider (an
 *    AI-Network-imported model, see networkModels.ts), route over the room
 *    regardless of `connectionMode` — an API-mode connection can't reach a
 *    provider that only exists on the room's other end. The resolved
 *    preset's `model` (label-or-model, see `advertisedModelName`) rides
 *    along so the room's provider can match it back to that preset.
 * 3. Otherwise, if the global `connectionMode` toggle is "network", use the
 *    room with no specific model (the room's provider picks its own
 *    default).
 * 4. Otherwise, resolve to a direct API connection using the task's
 *    resolved preset, with `reasoning_effort` set to
 *    `taskReasoningEfforts[task] ?? defaultReasoningEffort` (always a
 *    concrete value — "none" included, never omitted — overriding whatever
 *    the shared preset itself carries; see types.ts's `ReasoningEffort`).
 *
 * Returns null when nothing resolves yet (no shared config, no matching
 * preset and no room id).
 */
export function connectionForTask(task: LlmTask): LlmConnection | null {
  const config = loadLlmConfig();
  if (!config) return null;
  const settings = loadSettings();

  const presetId = settings.taskPresetIds[task] || undefined;
  const resolved = resolvePreset(config, presetId);

  if (resolved && isNetworkProviderBaseUrl(resolved.baseUrl)) {
    const roomId = config.network.roomId;
    return roomId ? { kind: "network", roomId, model: resolved.model } : null;
  }

  if (settings.connectionMode === "network") {
    const roomId = config.network.roomId;
    return roomId ? { kind: "network", roomId } : null;
  }

  if (!resolved) return null;

  const reasoningEffort: ReasoningEffort = settings.taskReasoningEfforts[task] ?? settings.defaultReasoningEffort;
  return { kind: "api", target: { ...resolved, reasoningEffort } };
}
