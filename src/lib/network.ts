import { createSharedNodeScope, createRoomConsumers, streamChatCompletion, formatMistaiError, MESSAGES_EN, MESSAGES_JA } from "@tik-choco/mistai";
import type { ChatMessage } from "@tik-choco/mistai";
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
// The chat wire has no reasoning-effort field. Use mistai's OAI tunnel and
// response parser so each consumer task keeps its own effort over rooms too.
export function requestNetworkChat(roomId: string, messages: ChatMessage[], model: string, reasoningEffort: string) {
  return streamChatCompletion({ baseUrl: "mist-network://" + roomId, apiKey: "", model, reasoningEffort }, messages, undefined,
    async (_url, init) => {
      const response = await rooms.requestRoomOpenAi(roomId, {
        path: "/chat/completions", method: "POST", contentType: "application/json", body: String(init?.body ?? ""),
      });
      return new Response(response.body, { status: response.status, headers: { "Content-Type": response.contentType } });
    });
}
export const requestNetworkTts = rooms.requestRoomTts;
export const requestNetworkStt = rooms.requestRoomStt;
export const requestNetworkOpenAi = rooms.requestRoomOpenAi;

export function localizeNetworkError(err: unknown, fallback: string): string {
  return formatMistaiError(err, getUiLanguage() === "ja" ? MESSAGES_JA : MESSAGES_EN, fallback);
}
