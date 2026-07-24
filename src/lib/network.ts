// App-side wiring for @tik-choco/mistai: injects the vendored mistlib node
// into the shared ConsumerClient and keeps the old function-style API so call
// sites read the same as before the migration. Also owns the localization of
// MistaiError codes (the library's messages are English by default) — unlike
// tc-translate (always Japanese), tc-lingo's UI language is a runtime
// setting, so the catalog choice follows it.
//
// createMistNode now goes through the shared MistNode facade
// (lib/mistNodeShared.ts, ported from tc-translate - see
// tc-docs/drafts/llm-settings-common-v1.md §4.7): mistlib-wasm only allows a
// single active MistNode per page, and this app now has THREE network stacks
// that each construct their own mistai `Network` - this ConsumerClient, the
// AI Network provider hook (hooks/useNetworkProvider.ts), and the oai tunnel
// client below - so the facade is required, not just an optimization.
// NODE_ID_STORAGE_KEY is the one nodeId every stack shares (all three are one
// peer on the wire).

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
import { createSharedMistNode } from "./mistNodeShared";
import { OaiTunnelClient } from "./p2p/tunnel";
import { getUiLanguage } from "../i18n";

// Kept distinct per app so installs never collide on the same origin. Also
// the ONE nodeId every network stack in this app derives from (see the
// shared MistNode facade note above) - do not introduce a second storage key
// for the provider hook or the oai tunnel client.
export const NODE_ID_STORAGE_KEY = "tc-lingo-mistllm-node-id-v1";

export function createMistNode(nodeId: string): MistNodeLike {
  return createSharedMistNode(nodeId);
}

export const networkClient = new ConsumerClient({
  createNode: createMistNode,
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
  requestTimeoutMs: 120_000,
  // ConsumerClient's own default (10s, see mistai's
  // DEFAULT_PROVIDER_WAIT_TIMEOUT_MS) is tuned for same-machine/dev testing;
  // a real cross-device LLM Network join (mistlib WebRTC peer discovery +
  // ICE negotiation over an actual LAN/WAN, especially the first connection
  // of a session) can take noticeably longer, and waitForEligibleProvider's
  // wait is already event-driven (resolves the instant a provider_hello
  // arrives, see mistai's resolveProviderWaiters) - so widening this ceiling
  // only delays the failure case, it never slows down a fast connection.
  // Bumped after a real-device report of "音声APIに接続できない" (network
  // TTS falling back to the browser voice) that self-resolved moments
  // later on retry once the room finished connecting in the background.
  providerWaitTimeoutMs: 30_000,
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

/** Requests speech synthesis over the LLM Network room; resolves with the audio Blob.
 * `lang` is a BCP-47 hint (see hooks/useSpeech.ts's `languageBcp47Tag`) so the
 * room's provider can pick a same-language voice/model instead of defaulting
 * to whatever it's configured for locally — see mistai's `selectProvider`
 * voice-aware routing and `SynthesizeFn`'s `lang` parameter. */
export function requestNetworkTts(
  roomId: string,
  params: { text: string; model?: string; voice?: string; lang?: string },
): Promise<Blob> {
  return networkClient.requestTts(roomId, params);
}

// Same node identity as networkClient: every stack shares the page's single
// MistNode (see createMistNode above), so the tunnel is just another handle
// on it - same peer id on the wire, own provider table and oai_* correlation.
// Ported from tc-translate's lib/network.ts (see
// tc-docs/drafts/llm-settings-common-v1.md §4.6) - no call site uses this yet
// in this app, kept for wire/API parity with tc-translate.
export const oaiTunnelClient = new OaiTunnelClient({
  createNode: createMistNode,
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
});

/** Proxies an OpenAI-compatible request through an 'oai'-capable room provider; body/response are UTF-8 text. */
export function requestNetworkOpenAi(
  roomId: string,
  req: { path: string; method?: "GET" | "POST"; contentType?: string; body?: string },
): Promise<{ status: number; contentType: string; body: string }> {
  return oaiTunnelClient.request(roomId, req);
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
