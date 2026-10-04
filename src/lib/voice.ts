import { resolveVoice, providerKind, type SharedLlmConfigV1 } from "./llmConfig";
import type { TtsEngine } from "../types";

export function deriveVoiceEngine(config: SharedLlmConfigV1, kind: "tts" | "stt"): TtsEngine {
  const target = resolveVoice(config, kind);
  return !target ? "browser" : providerKind(target) === "room" ? "network" : "api";
}
