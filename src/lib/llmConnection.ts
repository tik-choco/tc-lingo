// Resolves which LLM transport this app should actually use right now: a
// direct API preset from the shared llm config (lib/llmConfig.ts), or the
// P2P AI Network room (mistllm-wire v1) recorded at
// `llmConfig.network.roomId`. Which one is "current" is a local choice
// (settings.connectionMode); the room id itself is shared/co-owned, same as
// providers/presets — see llmConfig.ts's merge policy comment.
import { emptyLlmConfig, loadLlmConfig, resolvePreset, saveLlmConfig } from "./llmConfig";
import type { ResolvedLlmTargetV1, SharedLlmConfigV1 } from "./llmConfig";
import { loadSettings } from "./settings";
import type { LlmConnectionMode } from "../types";

/** The transport a caller should actually use. Distinct from `target`/`roomId`
 * alone in `resolveLlmConnection`'s return value: those report what each
 * transport resolves to independent of `mode`, while `connection` is null
 * whenever the currently selected mode isn't configured yet (no preset for
 * "api", no room id for "network") — callers should gate on `connection`,
 * not on `target`/`roomId` directly. */
export type LlmConnection = { kind: "api"; target: ResolvedLlmTargetV1 } | { kind: "network"; roomId: string };

export function resolveLlmConnection(): {
  config: SharedLlmConfigV1 | null;
  /** The resolved API preset, regardless of `mode` — present whenever a
   * preset is configured, even if `mode` is currently "network". */
  target: ResolvedLlmTargetV1 | null;
  mode: LlmConnectionMode;
  /** The shared AI Network room id, regardless of `mode`. "" if unset. */
  roomId: string;
  connection: LlmConnection | null;
} {
  const config = loadLlmConfig();
  const settings = loadSettings();
  const target = config ? resolvePreset(config, settings.presetId || undefined) : null;
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
