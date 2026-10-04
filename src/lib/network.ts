import { createSharedNodeScope, createRoomConsumers, formatMistaiError, MESSAGES_EN, MESSAGES_JA } from "@tik-choco/mistai";
import type { ChatMessage, RoomChatOptions } from "@tik-choco/mistai";
import { MistNode } from "../vendor/mistlib/wrappers/web/index.js";
import { mistSignalingConfig } from "./mistSignaling";
import { captureMistBuildInfo, markMistLoadError } from "./mistBuildInfo";
import { getUiLanguage } from "../i18n";

export const NODE_ID_STORAGE_KEY = "tc-lingo-mistllm-node-id-v1";
export const createMistNode = createSharedNodeScope(id => {
  const node = new MistNode(id, mistSignalingConfig());
  const init = node.init.bind(node);
  node.init = async () => {
    try { await init(); captureMistBuildInfo(); }
    catch (error) { markMistLoadError(); throw error; }
  };
  return node;
});
export const rooms = createRoomConsumers(createMistNode, {
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
  requestTimeoutMs: 120_000,
  providerWaitTimeoutMs: 30_000,
});
// Room chat carries task effort on llm_request and streams deltas directly.
export function requestNetworkChat(roomId: string, messages: ChatMessage[], model: string, reasoningEffort: string, onDelta?: RoomChatOptions["onDelta"]) {
  return rooms.requestRoomChat(roomId, messages, { model, reasoningEffort, onDelta });
}
export const requestNetworkTts = rooms.requestRoomTts;
export const requestNetworkStt = rooms.requestRoomStt;
// Only for image content parts (vision/OCR), /models and /embeddings.
export const requestNetworkOpenAi = rooms.requestRoomOpenAi;

export function localizeNetworkError(err: unknown, fallback: string): string {
  return formatMistaiError(err, getUiLanguage() === "ja" ? MESSAGES_JA : MESSAGES_EN, fallback);
}
