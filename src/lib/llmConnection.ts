import { isModelRef, loadLlmConfig, resolveModel, resolveModelExact, providerKind, roomIdFromBaseUrl } from "./llmConfig";
import type { ResolvedLlmTargetV1 } from "./llmConfig";
import { loadSettings } from "./settings";
import type { LlmTask, LlmTaskGroup, ReasoningEffort } from "../types";

export type LlmConnection =
  | { kind: "api"; target: ResolvedLlmTargetV1 }
  | { kind: "network"; roomId: string; model: string; reasoningEffort: ReasoningEffort };

export const TASK_GROUP: Record<Exclude<LlmTask, "decision">, LlmTaskGroup> = {
  practice: "correction",
  review: "correction",
  conversation: "correction",
  topic: "generation",
  cards: "generation",
  reading: "generation",
  grammar: "generation",
  "ui-translation": "generation",
  "card-organize": "card-organize",
};

export const CHAT_TASK_GROUPS: readonly LlmTaskGroup[] = ["correction", "generation", "card-organize"];

function connectionFromTarget(target: ResolvedLlmTargetV1 | null, effort: ReasoningEffort): LlmConnection | null {
  if (!target) return null;
  return providerKind(target) === "room"
    ? { kind: "network", roomId: roomIdFromBaseUrl(target.baseUrl), model: target.model, reasoningEffort: effort }
    : { kind: "api", target: { ...target, reasoningEffort: effort } };
}

export function resolveLlmConnection() {
  const config = loadLlmConfig();
  const target = config ? resolveModel(config) : null;
  const connection = connectionFromTarget(target, "none");
  return { config, target, connection, mode: connection?.kind === "network" ? "network" as const : "api" as const,
    roomId: connection?.kind === "network" ? connection.roomId : "" };
}

export function connectionForTask(task: LlmTask): LlmConnection | null {
  if (task === "decision") return connectionFromTarget(decisionTargetForApp(), "none");
  const settings = loadSettings();
  const config = loadLlmConfig();
  const group = TASK_GROUP[task];
  const local = settings.tasks[group];
  const ref = isModelRef(local?.ref) ? local.ref : undefined;
  return connectionFromTarget(config ? resolveModel(config, ref) : null, group === "card-organize" ? "none" : local?.reasoningEffort ?? "none");
}

export function decisionTargetForApp(): ResolvedLlmTargetV1 | null {
  try {
    const ref = loadSettings().tasks.decision?.ref;
    if (!isModelRef(ref)) return null;
    const config = loadLlmConfig();
    return config ? resolveModelExact(config, ref) : null;
  } catch {
    return null;
  }
}
