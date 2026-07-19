// Owns the "participate as an LLM Network provider" lifecycle for this app:
// joins/leaves the configured room, forwards llm_request/tts_request traffic
// to the user's configured shared presets, and surfaces connection/peer/
// request-log state for the UI. Net-new for tc-lingo — modeled closely on
// tc-translate's src/hooks/useNetworkProvider.ts (see
// tc-docs/drafts/llm-settings-common-v1.md §4.5/§5), adapted to this app's
// shape: there's no local `ProviderSettings`/`TtsSettings` merge layer here,
// just `LingoSettings` (lib/settings.ts) plus the shared llm config
// (lib/llmConfig.ts) directly, and there's no STT at all (no `transcribe`
// upstream is ever injected, so this provider never advertises the "stt"
// service).
//
// Independent of `settings.connectionMode` — provider mode can run alongside
// this app consuming via direct API for its own practice/reading/etc. calls.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MistaiError } from "@tik-choco/mistai";
import type { NetworkProviderPeer, NetworkProviderStatus, UseNetworkProviderResult } from "@tik-choco/mistai/preact";
import { requestResolvedChatCompletionStreaming } from "../lib/llm";
import { resolvePreset, resolveVoice, type ResolvedLlmTargetV1, type SharedLlmConfigV1 } from "../lib/llmConfig";
import { createMistNode, NODE_ID_STORAGE_KEY } from "../lib/network";
import { advertisedModelName, isNetworkProviderBaseUrl } from "../lib/networkModels";
import { OAI_TUNNEL_SERVICE } from "../lib/p2p/protocol";
import { OaiTunnelProvider, type OaiUpstreamResolver } from "../lib/p2p/tunnel";
import { synthesizeSpeechApi } from "../lib/tts";
import type { LingoSettings } from "../types";
import { useMistaiNetworkProvider } from "./useMistaiProvider";

export type { NetworkProviderPeer, NetworkProviderStatus };

/**
 * Resolves `presetIds` (the shared-config preset ids the user checked to
 * share, see `LingoSettings.networkProviderPresetIds`) against the shared llm
 * config. Drops ids that no longer resolve, ids whose resolution silently
 * fell back to the shared default preset (see `resolvePreset`'s fallback -
 * this guards against re-sharing the default preset under a stale/removed
 * id), and any target whose baseUrl is itself a `mist-network://`
 * pseudo-provider - re-advertising a network-imported preset would loop
 * traffic straight back into the room it came from.
 */
export function resolveSharedTargets(llmConfig: SharedLlmConfigV1, presetIds: string[]): ResolvedLlmTargetV1[] {
  const targets: ResolvedLlmTargetV1[] = [];
  for (const id of presetIds) {
    const resolved = resolvePreset(llmConfig, id);
    if (!resolved || resolved.presetId !== id) continue;
    if (isNetworkProviderBaseUrl(resolved.baseUrl)) continue;
    targets.push(resolved);
  }
  return targets;
}

export function useNetworkProvider(settings: LingoSettings, llmConfig: SharedLlmConfigV1) {
  // Ride settings/llmConfig in refs so in-flight requests always see the
  // latest values without retriggering the room join effect.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const llmConfigRef = useRef(llmConfig);
  llmConfigRef.current = llmConfig;

  // Presets the user explicitly checked to share
  // (settings.networkProviderPresetIds), resolved to concrete connections.
  const sharedTargets = useMemo(
    () => resolveSharedTargets(llmConfig, settings.networkProviderPresetIds),
    [llmConfig, settings.networkProviderPresetIds],
  );
  const sharedTargetsRef = useRef(sharedTargets);
  sharedTargetsRef.current = sharedTargets;

  // What each shared preset is advertised as in provider_hello.models: its
  // label, falling back to the model id (see advertisedModelName). Deduped,
  // sorted and joined into a single string so the useMemo below doesn't
  // retrigger on array-identity churn when the underlying set hasn't actually
  // changed. Share-list edits propagate to already-connected consumers
  // without dropping the session: useMistaiProvider re-broadcasts
  // provider_hello in place whenever this set changes.
  const advertisedModelsKey = [...new Set(sharedTargets.map(advertisedModelName))].sort().join("\n");
  const advertisedModels = useMemo(
    () => (advertisedModelsKey ? advertisedModelsKey.split("\n") : []),
    [advertisedModelsKey],
  );

  // The shared config's own default preset counts as a fallback upstream
  // only when it's an actual HTTP endpoint - a default preset that resolves
  // to a `mist-network://` pseudo-provider can't be forwarded upstream into
  // the network it came from. Sharing via the checkboxes (sharedTargets) is
  // independently sufficient even without a usable default preset.
  const defaultTarget = resolvePreset(llmConfig);
  const upstreamConfigured =
    sharedTargets.length > 0 || Boolean(defaultTarget && !isNetworkProviderBaseUrl(defaultTarget.baseUrl));

  // TTS serving is only advertised when the shared config's own `tts` entry
  // resolves to a real HTTP endpoint - never when it resolves to (or falls
  // back to a default preset backed by) a `mist-network://` pseudo-provider,
  // which would just loop the request straight back into the room it came
  // from. This app has no STT at all, so `transcribe` is never injected
  // below - useMistaiNetworkProvider (mistai's deriveHelloServices) already
  // omits "stt" from provider_hello.services whenever no transcribe function
  // is passed.
  const ttsVoice = resolveVoice(llmConfig, "tts");
  const ttsConfigured = Boolean(ttsVoice && !isNetworkProviderBaseUrl(ttsVoice.baseUrl));

  const [debouncedRoomId, setDebouncedRoomId] = useState(llmConfig.network.roomId);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRoomId(llmConfig.network.roomId), 500);
    return () => clearTimeout(timer);
  }, [llmConfig.network.roomId]);

  // Resolves which upstream serves an incoming oai_* tunnel request (an
  // OpenAI-compatible HTTP call proxied over P2P, see '../lib/p2p/tunnel').
  // Consumer-supplied auth never exists on the wire - whichever upstream is
  // chosen here is always forwarded to with THIS provider's own api key,
  // same as callLlm below. Paths are allowlisted; anything not matched below
  // returns null and the tunnel answers with an 'unsupported_path' error
  // instead of forwarding an arbitrary path to an upstream. Reads refs (not
  // the closed-over settings/llmConfig/sharedTargets) so it stays correct
  // across renders without needing to be recreated on every one - it's
  // invoked from inside the per-session tunnel-provider factory below.
  const resolveOaiUpstream: OaiUpstreamResolver = (path, body) => {
    const targets = sharedTargetsRef.current;
    const config = llmConfigRef.current;
    const fallback = resolvePreset(config);
    const fallbackUsable = fallback && !isNetworkProviderBaseUrl(fallback.baseUrl) ? fallback : null;

    if (path === "/chat/completions") {
      const bodyObj = body as { model?: unknown } | undefined;
      const requested = typeof bodyObj?.model === "string" ? bodyObj.model : "";
      const matched = targets.find((target) => advertisedModelName(target) === requested);
      if (matched) {
        return {
          baseUrl: matched.baseUrl,
          apiKey: matched.apiKey,
          // stream:false - the tunnel is single-shot v1 (no chunked delta relay yet).
          rewriteBody: (b) => ({ ...(b as object), model: matched.model, stream: false }),
        };
      }
      // Same share-list policy as callLlm below: a named model that isn't in
      // the advertised set is refused (relayed as 'request_rejected'), never
      // silently served by another upstream/model. Model-less requests fall
      // through to the default-upstream choices.
      if (requested && targets.length > 0) {
        throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "The requested model is not shared by this provider.");
      }
      if (fallbackUsable) {
        return {
          baseUrl: fallbackUsable.baseUrl,
          apiKey: fallbackUsable.apiKey,
          rewriteBody: (b) => ({ ...(b as object), model: fallbackUsable.model, stream: false }),
        };
      }
      if (targets.length > 0) {
        const first = targets[0];
        return {
          baseUrl: first.baseUrl,
          apiKey: first.apiKey,
          rewriteBody: (b) => ({ ...(b as object), model: first.model, stream: false }),
        };
      }
      return null;
    }

    if (path === "/models" || path === "/embeddings") {
      // /embeddings: no rewriteBody - embeddings models aren't label-mapped
      // to shared-target models yet, so the requested model rides through
      // unchanged instead of being rewritten like /chat/completions above.
      if (targets.length > 0) return { baseUrl: targets[0].baseUrl, apiKey: targets[0].apiKey };
      if (fallbackUsable) return { baseUrl: fallbackUsable.baseUrl, apiKey: fallbackUsable.apiKey };
      return null;
    }

    return null;
  };

  const result = useMistaiNetworkProvider({
    enabled: settings.networkProviderEnabled && upstreamConfigured,
    roomId: debouncedRoomId,
    createNode: createMistNode,
    nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    extraServices: [OAI_TUNNEL_SERVICE],
    createTunnelProvider: (send) => new OaiTunnelProvider(send, resolveOaiUpstream),
    callLlm: (messages, model, onDelta) => {
      const targets = sharedTargetsRef.current;
      // A model-specific llm_request: the requested name is the advertised
      // name (label-or-model, see advertisedModelName) echoed back by the
      // consumer - map it to the matching shared preset and forward via that
      // preset's own connection, not the shared config's default preset
      // (which may not even offer this model).
      if (model) {
        const matched = targets.find((target) => advertisedModelName(target) === model);
        if (matched) return requestResolvedChatCompletionStreaming(matched, messages, onDelta);
        // A model was named but isn't in the current share list. While this
        // provider advertises a list at all, honoring the request anyway
        // would let consumers keep using entries the user just un-shared -
        // stale imported cards, or hand-crafted requests naming real
        // upstream model ids. Refuse instead; only a provider with NO
        // advertised list still forwards named requests below.
        if (targets.length > 0) {
          throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "The requested model is not shared by this provider.");
        }
      }
      // No model requested (or one was, but nothing is advertised): the
      // shared config's default preset normally answers these, EXCEPT when
      // that default preset is itself network-imported (forwarding there
      // would loop the request back into the room it came from) - in that
      // case fall back to the first shared target instead, so a provider
      // sharing only via the checkboxes still answers model-less requests.
      const config = llmConfigRef.current;
      const fallback = resolvePreset(config);
      if (fallback && !isNetworkProviderBaseUrl(fallback.baseUrl)) {
        return requestResolvedChatCompletionStreaming(fallback, messages, onDelta);
      }
      if (targets.length > 0) return requestResolvedChatCompletionStreaming(targets[0], messages, onDelta);
      throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "This provider has no LLM endpoint configured.");
    },
    advertisedModels: advertisedModels.length ? advertisedModels : undefined,
    synthesize: ttsConfigured
      ? async (text, model, voice) => {
          const voiceTarget = resolveVoice(llmConfigRef.current, "tts");
          // Config may have changed since ttsConfigured was computed (e.g.
          // the resolved model got unset, falling back to the network
          // pseudo-provider) - re-check here too, so we never forward into
          // the network room this capability was advertised to.
          if (!voiceTarget || isNetworkProviderBaseUrl(voiceTarget.baseUrl)) {
            throw new Error("This provider's TTS endpoint is not configured.");
          }
          // The requested model is whatever the consumer's picker stored -
          // typically an advertised chat-preset name (a label, not a model
          // id in this provider's TTS catalog) - so it's only forwarded
          // upstream when it matches this provider's own configured TTS
          // model; anything else falls back to that own model instead of
          // erroring.
          const ownTtsModel = voiceTarget.model;
          const blob = await synthesizeSpeechApi(text, {
            baseUrl: voiceTarget.baseUrl,
            apiKey: voiceTarget.apiKey,
            model: model === ownTtsModel ? model : ownTtsModel,
            voice: voice || voiceTarget.voice,
            speed: voiceTarget.speed,
          });
          return { blob, mime: blob.type || "audio/mpeg" };
        }
      : undefined,
  });

  const state: NetworkProviderState = {
    ...result,
    errorMessage: result.errorMessage ?? "",
    ownNodeId: result.ownNodeId ?? "",
    upstreamConfigured,
  };

  // Publish for useNetworkProviderStatus() below - display-only consumers
  // (SettingsView's AI Network tab) read the latest result this way instead
  // of calling this hook themselves, which would join the room a second time
  // under the same shared MistNode identity (see lib/mistNodeShared.ts) and
  // double up request handling. Runs after render (not during) so it never
  // notifies another component's setState while this one is still rendering.
  useEffect(() => {
    publishNetworkProviderState(state);
  });

  return state;
}

/** Full `useNetworkProvider` result, including the `upstreamConfigured` flag
 * this hook adds on top of `UseNetworkProviderResult` (see above) - and with
 * `errorMessage`/`ownNodeId` narrowed from `string | null` to plain `string`,
 * matching the `?? ""` normalization the hook applies below before ever
 * publishing/returning a state object. */
export type NetworkProviderState = Omit<UseNetworkProviderResult, "errorMessage" | "ownNodeId"> & {
  errorMessage: string;
  ownNodeId: string;
  upstreamConfigured: boolean;
};

const defaultNetworkProviderState: NetworkProviderState = {
  status: "idle",
  statusUpdatedAt: 0,
  errorMessage: "",
  peers: [],
  peerCount: 0,
  consumerCount: 0,
  logs: [],
  ownNodeId: "",
  roomId: "",
  upstreamConfigured: false,
};

let latestNetworkProviderState = defaultNetworkProviderState;
const networkProviderStateListeners = new Set<() => void>();

function publishNetworkProviderState(state: NetworkProviderState): void {
  latestNetworkProviderState = state;
  for (const listener of networkProviderStateListeners) listener();
}

/**
 * Read-only view of the single `useNetworkProvider` instance mounted in
 * app.tsx (see the module doc comment above and app.tsx's own comment on why
 * that hook lives there instead of per-view) — for the AI Network tab's
 * provider status panel, which needs to *display* this state without
 * instantiating its own second provider session.
 */
export function useNetworkProviderStatus(): NetworkProviderState {
  const [state, setState] = useState(latestNetworkProviderState);
  useEffect(() => {
    const listener = () => setState(latestNetworkProviderState);
    networkProviderStateListeners.add(listener);
    return () => {
      networkProviderStateListeners.delete(listener);
    };
  }, []);
  return state;
}
