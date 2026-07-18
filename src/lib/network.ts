// App-side wiring for @tik-choco/mistai: injects the vendored mistlib node
// into the shared ConsumerClient and keeps the old function-style API so call
// sites read the same as before the migration. Also owns the localization of
// MistaiError codes (the library's messages are English by default) — unlike
// tc-translate (always Japanese), tc-lingo's UI language is a runtime
// setting, so the catalog choice follows it.

import {
  ConsumerClient,
  MESSAGES_EN,
  MESSAGES_JA,
  formatMistaiCode,
  formatMistaiError,
  type ConsumerStatus,
  type ConsumerStatusListener,
  type ChatMessage,
  type MistNodeLike,
  type MistaiMessages,
} from "@tik-choco/mistai";
import { MistNode } from "../vendor/mistlib/wrappers/web/index.js";
import { getUiLanguage } from "../i18n";

// Kept distinct per app so installs never collide on the same origin.
export const NODE_ID_STORAGE_KEY = "tc-lingo-mistllm-node-id-v1";

export function createMistNode(nodeId: string): MistNodeLike {
  return new MistNode(nodeId);
}

export const networkClient = new ConsumerClient({
  createNode: createMistNode,
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
  requestTimeoutMs: 120_000,
});

export type { ConsumerStatus, ConsumerStatusListener };

/** Subscribes to consumer connection status changes. Returns an unsubscribe function. */
export function onConsumerStatusChange(listener: ConsumerStatusListener): () => void {
  return networkClient.onStatusChange(listener);
}

/** Eagerly connects to the LLM Network room; errors surface via status, never thrown. */
export function connectNetworkConsumer(roomId: string): Promise<void> {
  return networkClient.connect(roomId);
}

/** Tears down the active/pending consumer session and resets status to idle. */
export function disconnectNetworkConsumer(): void {
  networkClient.disconnect();
}

/** Sends a chat request over the LLM Network room and resolves with the full reply text. */
export function requestNetworkChat(
  roomId: string,
  messages: ChatMessage[],
  model?: string,
  onDelta?: (delta: string, full: string) => void,
): Promise<string> {
  return networkClient.requestChat(roomId, messages, { model, onDelta });
}

/** Requests speech synthesis over the LLM Network room; resolves with the audio Blob. */
export function requestNetworkTts(
  roomId: string,
  params: { text: string; model?: string; voice?: string },
): Promise<Blob> {
  return networkClient.requestTts(roomId, params);
}

// ---------------------------------------------------------------------------
// Localization rides the library's canonical MESSAGES_JA/MESSAGES_EN
// catalogs so wording stays consistent with the other apps. Unlike
// tc-translate (fixed MESSAGES_JA), tc-lingo's UI language follows
// settings.nativeLanguage, so the catalog is picked at call time; the
// library's own English catalog covers every other UI language for now.

/**
 * User-facing message for any error coming out of a network (or mixed
 * network/API) code path, localized to the current UI language. Non-MistaiError
 * errors keep their own message; non-Error values yield `fallback`.
 */
export function localizeNetworkError(err: unknown, fallback: string): string {
  return formatMistaiError(err, uiCatalog(), fallback);
}

/**
 * Localized message for a ConsumerStatus error phase. Unlike thrown errors,
 * the status object carries a bare `code`/`message` pair (not a MistaiError
 * instance), so the catalog lookup goes through the code directly; statuses
 * without a code fall back to the library's raw (English) message.
 */
export function localizeConsumerError(status: ConsumerStatus, fallback: string): string {
  if (status.phase !== "error") return fallback;
  return formatMistaiCode(status.code, uiCatalog()) ?? (status.message || fallback);
}

function uiCatalog(): MistaiMessages {
  return getUiLanguage() === "ja" ? MESSAGES_JA : MESSAGES_EN;
}
