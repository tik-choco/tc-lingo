// "Read this aloud" for any piece of learner-facing text (a card's front, an
// example sentence, a topic prompt, ...). Ported from tc-translate's
// hooks/useSpeech.ts, adapted to tc-lingo's shape: views here are
// self-contained (no props — see CLAUDE.md), so this hook takes no arguments
// and instead reads the shared llm config's `tts`/`network.roomId`
// (lib/llmConfig.ts) itself, once per speak()/speakSequence() call, so a
// mid-session settings change always takes effect on the next play without
// needing a re-mount. The engine itself is never stored locally — it is
// always DERIVED from the shared config by lib/voice.ts's
// `deriveVoiceEngine` (see tc-docs/drafts/llm-settings-common-v1.md §4.1),
// same as tc-translate.
//
// Three engines, one id-keyed toggle API:
//   - "browser": the Web Speech API (speechSynthesis) directly.
//   - "api": an OpenAI-compatible `/audio/speech` endpoint, resolved via
//     resolveVoice(config, "tts") and fetched by lib/tts.ts's
//     synthesizeSpeechApi.
//   - "network": the same kind of endpoint, reached over the AI Network room
//     via lib/network.ts's requestNetworkTts. A configured model of
//     `NETWORK_VOICE_AUTO_MODEL` ("network-auto" — the AI Network tab's
//     "let the room decide" option) is stripped from the wire request by
//     lib/networkModels.ts's `networkVoiceModelParam`, so the room's
//     provider falls back to its own configured TTS model.
// Both "api" and "network" also send the spoken text's BCP-47 language tag
// (languageBcp47Tag(language) — the same tag "browser" sets on
// SpeechSynthesisUtterance.lang): "network" forwards it as `tts_request.lang`
// so the room's provider (and mistai's provider-selection) can favor a
// same-language voice/model instead of whatever it happens to be configured
// for by default (see tc-docs' AI Network TTS lang-hint fix); "api" doesn't
// send it over the wire (no such field in the OpenAI TTS request shape) but
// both engines use it locally to resolve a per-language voice override, if
// the learner set one — see lib/ttsVoiceByLanguage.ts's `resolveVoiceOverride`
// and LingoSettings.ttsVoiceByLanguage — ahead of falling back to
// config.tts?.voice. "network" additionally guards that global fallback
// against a stale-voice trap the "explicit voice beats the lang hint" wire
// contract would otherwise fall into: if config.tts?.voice is a kokoro-style
// voice id (e.g. "jf_alpha") whose self-encoded language doesn't match the
// text's lang, it's omitted from the request instead of sent — see
// lib/ttsVoiceByLanguage.ts's `resolveNetworkVoice`/
// `isLangMismatchedKokoroVoice`. "api" never applies this guard (no `lang` on
// the wire there for a provider to react to anyway), nor does a per-language
// override (the learner picked that one specifically for this language, so
// it's trusted outright regardless of its shape).
// "api"/"network" both fall back to the browser voice: silently if they were
// simply unconfigured (no resolved voice / no room id), or with
// `speechError` set to a localized notice if a configured attempt actually
// failed (network error, non-OK response, ...). Calling speak() again with
// the same `id` that's currently speaking/loading toggles playback off
// (stop()), matching tc-translate's behavior.
//
// speakSequence() plays an array of texts (e.g. one per sentence of a
// passage) under a single id. Reading a whole passage as one TTS request
// means the learner waits for the entire audio to render before hearing
// anything; for the HTTP engines ("api"/"network") we instead pipeline the
// per-chunk requests — while chunk N plays, chunk N+1 is already being
// fetched — so total wait is roughly "first chunk only" instead of "sum of
// all chunks", while playback still sounds gapless most of the time. The
// browser engine has no request latency to hide, so it's just a chain of
// utterances. Both paths reuse the same generation-counter/stop() machinery
// as speak() so a stop() or a new speak()/speakSequence() call cleanly
// supersedes whatever is in flight.
import { useEffect, useRef, useState } from "preact/hooks";
import { emptyLlmConfig, loadLlmConfig, resolvePreset, resolveVoice } from "../lib/llmConfig";
import type { SharedLlmConfigV1 } from "../lib/llmConfig";
import { languageBcp47Tag } from "../lib/languages";
import { localizeNetworkError, networkClient, requestNetworkTts } from "../lib/network";
import { isNetworkProviderBaseUrl, networkVoiceModelParam } from "../lib/networkModels";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { resolveNetworkVoice, resolveVoiceOverride, type NetworkVoiceResolution } from "../lib/ttsVoiceByLanguage";
import { synthesizeSpeechApi } from "../lib/tts";
import { deriveVoiceEngine } from "../lib/voice";
import { t } from "../i18n";

export interface SpeechController {
  supported: boolean;
  speakingId: string | null;
  loadingId: string | null;
  /** Index (into the array passed to speakSequence) of the chunk currently
   * playing/being spoken; null when idle or during a single speak(). */
  speakingIndex: number | null;
  speechError: string;
  speak(text: string, language: string, id: string): void;
  speakSequence(texts: string[], language: string, id: string): void;
  stop(): void;
}

/** One sequence chunk paired with its position in the caller's original
 * array — blank chunks are filtered out before playback, so the position
 * has to travel alongside the text rather than being re-derived from an
 * index into a (possibly shorter) filtered list. */
interface SequenceItem {
  text: string;
  index: number;
}

/** Outcome of fetching one chunk's audio, tagged so a rejected prefetch can
 * be awaited later without ever becoming an unhandled rejection. */
type ChunkFetchResult = { blob: Blob } | { error: unknown };

function browserSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** DevTools-only diagnostics for a failed API/network TTS attempt: the raw
 * error alongside the consumer's current provider table (which peers are
 * connected and what `services`/`voices` each one advertised in its last
 * `provider_hello`) — the single most useful thing to check when "no tts
 * provider was found" (was a provider even discovered? did it advertise
 * "tts"?) vs. an actual upstream failure needs telling apart on a real
 * device where there's no other way to see the wire state. Console-only by
 * design: this can be a lot of detail, and the AI Network tab's own status
 * display already covers the UI-facing summary. */
function logTtsFailureDiagnostics(err: unknown): void {
  console.warn("[useSpeech] TTS request failed; falling back to the browser voice.", err, {
    consumerStatus: networkClient.status,
  });
}

/** How `deriveVoiceEngine`'s underlying provider lookup (lib/voice.ts /
 * `resolveVoice`, lib/llmConfig.ts) actually resolved a provider for the
 * `[lingo tts]` diagnostic log below — the "why" behind the logged `engine`,
 * for exactly the report that's hardest to debug from the UI alone: "I picked
 * my own API endpoint but it's speaking in [some other provider]'s voice".
 * `config[kind].providerId` is optional by design (lib/llmConfig.ts's
 * `VoiceConfigV1` doc comment: "providerId 省略時は defaultPreset の
 * provider にフォールバック") — a TTS target with no explicit providerId
 * silently rides on `config.defaultPresetId` instead, so if that ever points
 * at an AI-Network mirror preset (see hooks/useNetworkModelSync.ts), every
 * such target flips to the network engine with no configuration change
 * visible in the TTS row itself. */
type VoiceProviderSource = "explicit" | "defaultPreset" | "unresolved";

interface VoiceProviderResolution {
  providerSource: VoiceProviderSource;
  /** Hostname only (never the apiKey, never the full URL/query) — safe to
   * log. `mist-network://<roomId>` isn't a real host; logged verbatim since
   * the room id itself isn't a secret and is exactly the useful bit here. */
  baseUrlHost?: string;
}

function baseUrlHostForLog(baseUrl: string): string {
  if (isNetworkProviderBaseUrl(baseUrl)) return baseUrl;
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return "(unparseable-url)";
  }
}

function describeVoiceProviderResolution(config: SharedLlmConfigV1, kind: "tts" | "stt"): VoiceProviderResolution {
  const cfg = config[kind];
  if (!cfg || !cfg.model) return { providerSource: "unresolved" };

  if (cfg.providerId) {
    const provider = config.providers.find((p) => p.id === cfg.providerId);
    return provider
      ? { providerSource: "explicit", baseUrlHost: baseUrlHostForLog(provider.baseUrl) }
      : { providerSource: "unresolved" };
  }

  const defaultTarget = resolvePreset(config);
  const provider = defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined;
  return provider
    ? { providerSource: "defaultPreset", baseUrlHost: baseUrlHostForLog(provider.baseUrl) }
    : { providerSource: "unresolved" };
}

/** DevTools-only diagnostic for exactly what's about to go out over the AI
 * Network room for a "network" engine TTS request — the single most useful
 * thing to check when a learner reports "it's reading English in a Japanese
 * voice" (or vice versa): was a per-language override in play, was the global
 * voice suppressed for a lang mismatch, and what actually got sent. See
 * lib/ttsVoiceByLanguage.ts's `resolveNetworkVoice` for the source values.
 * `providerSource`/`baseUrlHost` (see `describeVoiceProviderResolution`)
 * explain HOW `engine: "network"` was even reached — most usefully,
 * `providerSource: "defaultPreset"` means this room ended up in the request
 * only because `tts.providerId` was left unset, not because the learner
 * explicitly chose it. */
function logNetworkTtsRequest(
  lang: string,
  voice: string | undefined,
  voiceSource: NetworkVoiceResolution["source"],
  model: string | undefined,
  text: string,
  providerResolution: VoiceProviderResolution,
): void {
  console.info("[lingo tts]", {
    engine: "network",
    lang,
    voice,
    voiceSource,
    model,
    providerSource: providerResolution.providerSource,
    baseUrlHost: providerResolution.baseUrlHost,
    textPreview: text.slice(0, 30),
  });
}

/** DevTools-only diagnostic for an "api" engine TTS request, mirroring
 * `logNetworkTtsRequest`'s shape (see its doc comment) so the two engines'
 * log lines read the same way — this is the one to check for "I'm sure I
 * configured my own API endpoint, but it's speaking in the wrong
 * voice/language": `baseUrlHost` says which endpoint the request is actually
 * going to, and `providerSource` says whether that came from an explicit
 * `tts.providerId` or (silently) from `config.defaultPresetId` — see
 * `describeVoiceProviderResolution`. Deliberately logs only the hostname,
 * never the apiKey or full URL. */
function logApiTtsRequest(
  lang: string,
  voice: string | undefined,
  model: string,
  text: string,
  providerResolution: VoiceProviderResolution,
): void {
  console.info("[lingo tts]", {
    engine: "api",
    lang,
    voice,
    model,
    providerSource: providerResolution.providerSource,
    baseUrlHost: providerResolution.baseUrlHost,
    textPreview: text.slice(0, 30),
  });
}

/** Whether *some* playback path is currently usable — the browser voice, or
 * a configured API/Network TTS target — independent of which engine
 * `deriveVoiceEngine` currently derives (any of the three can be reached
 * via the browser fallback). */
function resolveSupported(): boolean {
  if (browserSpeechSupported()) return true;
  const config = loadLlmConfig() ?? emptyLlmConfig();
  const apiConfigured = Boolean(resolveVoice(config, "tts"));
  const roomConfigured = Boolean(config.network.roomId.trim());
  return apiConfigured || roomConfigured;
}

export function useSpeech(): SpeechController {
  const [supported, setSupported] = useState(resolveSupported);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [speechError, setSpeechError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // Bumped on every stop()/speak() so a slow (api/network) getBlob() that
  // resolves after the user moved on can't resurrect playback (or an error/
  // fallback) they already dismissed.
  const playGenerationRef = useRef(0);
  // While a sequence chunk's audio.play() is being awaited, this lets stop()
  // unblock that wait immediately (pause() alone fires neither "ended" nor
  // "error", so without this the await would hang until the tab closes).
  // The generation check right after the await distinguishes "stop() woke us
  // up" from "the audio element actually errored".
  const stopSignalRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    function refresh() {
      setSupported(resolveSupported());
    }
    window.addEventListener("storage", refresh);
    const unsubscribeSettings = subscribeSettings(refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      unsubscribeSettings();
    };
  }, []);

  useEffect(() => {
    return () => {
      // Bump the generation before signaling, or a woken sequence loop would
      // read "playback failed" and keep talking via the browser fallback
      // after unmount.
      playGenerationRef.current += 1;
      if (browserSpeechSupported()) window.speechSynthesis.cancel();
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      stopSignalRef.current?.();
    };
  }, []);

  function stop(): void {
    playGenerationRef.current += 1;
    stopSignalRef.current?.();
    stopSignalRef.current = null;
    if (browserSpeechSupported()) window.speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setSpeakingId(null);
    setLoadingId(null);
    setSpeakingIndex(null);
  }

  function speakWithBrowser(text: string, lang: string, id: string): void {
    if (!browserSpeechSupported()) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (lang) utterance.lang = lang;
    utterance.onend = () => setSpeakingId((current) => (current === id ? null : current));
    utterance.onerror = (event) => {
      // cancel() itself fires "canceled"/"interrupted" on whatever utterance
      // it aborts — expected (see e.g. tc-news's lib/tts.ts), not a real
      // failure, so it shouldn't surface as speechError.
      if (event.error === "canceled" || event.error === "interrupted") return;
      setSpeakingId((current) => (current === id ? null : current));
    };
    window.speechSynthesis.speak(utterance);
    setSpeakingId(id);
  }

  /** Chain of utterances for speakSequence's browser path. No per-request
   * latency to hide here (unlike the HTTP engines), so this is just
   * onend-driven advancement rather than a pipeline. */
  function playSequenceWithBrowser(items: SequenceItem[], lang: string, id: string): void {
    if (!browserSpeechSupported() || items.length === 0) {
      setSpeakingId((current) => (current === id ? null : current));
      setSpeakingIndex(null);
      return;
    }

    const generation = playGenerationRef.current;

    function speakAt(i: number): void {
      if (generation !== playGenerationRef.current) return; // stop()'d/superseded
      if (i >= items.length) {
        setSpeakingId((current) => (current === id ? null : current));
        setSpeakingIndex(null);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(items[i].text);
      if (lang) utterance.lang = lang;
      utterance.onend = () => speakAt(i + 1);
      utterance.onerror = (event) => {
        // As in speakWithBrowser: cancellation isn't a real failure. A real
        // error still just advances, same as a normal chunk end.
        if (event.error === "canceled" || event.error === "interrupted") return;
        speakAt(i + 1);
      };

      setSpeakingIndex(items[i].index);
      setSpeakingId(id);
      window.speechSynthesis.speak(utterance);
    }

    speakAt(0);
  }

  async function playFromSource(
    getBlob: () => Promise<Blob>,
    text: string,
    lang: string,
    id: string,
  ): Promise<void> {
    const generation = playGenerationRef.current;
    setSpeechError("");
    setLoadingId(id);

    try {
      const blob = await getBlob();
      if (generation !== playGenerationRef.current) return; // superseded by stop()/another speak()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setSpeakingId((current) => (current === id ? null : current));
      audio.onerror = () => setSpeakingId((current) => (current === id ? null : current));

      setLoadingId(null);
      setSpeakingId(id);
      await audio.play();
    } catch (err) {
      if (generation !== playGenerationRef.current) return; // superseded; don't resurrect error/fallback
      setLoadingId(null);
      if (browserSpeechSupported()) {
        // The generic notice is all that's guaranteed to make sense in every
        // UI language, but the underlying cause (e.g. "no tts provider
        // found" vs. the room's provider itself rejecting the request) is
        // still worth surfacing for anyone debugging a real-device setup -
        // console for whoever's watching DevTools, and appended to the
        // visible notice itself so it doesn't require opening DevTools at
        // all. See localizeNetworkError's REMOTE_ERROR handling for how a
        // provider-authored voice_error message flows through here verbatim.
        logTtsFailureDiagnostics(err);
        const detail = localizeNetworkError(err, "");
        setSpeechError(detail ? `${t("app-tts-fallback-browser")} (${detail})` : t("app-tts-fallback-browser"));
        speakWithBrowser(text, lang, id);
        return;
      }
      setSpeechError(localizeNetworkError(err, t("app-tts-failed")));
      setSpeakingId(null);
    }
  }

  /** Pipelined playback for speakSequence's "api"/"network" engines: while
   * chunk i plays, chunk i+1's audio is already being fetched, so by the
   * time chunk i ends its successor is usually ready (or close to it) —
   * only the very first chunk pays full fetch latency before sound starts. */
  async function playSequenceFromSource(
    getBlob: (text: string) => Promise<Blob>,
    items: SequenceItem[],
    lang: string,
    id: string,
  ): Promise<void> {
    const generation = playGenerationRef.current;
    setSpeechError("");
    setLoadingId(id);

    function fetchChunk(text: string): Promise<ChunkFetchResult> {
      return getBlob(text)
        .then((blob) => ({ blob }))
        .catch((error) => ({ error }));
    }

    /** Fall back the remaining chunks (starting from the one that just
     * failed) to the browser voice, or — if the browser voice isn't even
     * available — surface the error and give up, mirroring speak()'s
     * single-source fallback policy. */
    function fallbackOrFail(remaining: SequenceItem[], err: unknown): void {
      setLoadingId(null);
      if (browserSpeechSupported()) {
        // See playFromSource's catch block for why this surfaces `err`
        // instead of just the generic notice.
        logTtsFailureDiagnostics(err);
        const detail = localizeNetworkError(err, "");
        setSpeechError(detail ? `${t("app-tts-fallback-browser")} (${detail})` : t("app-tts-fallback-browser"));
        playSequenceWithBrowser(remaining, lang, id);
        return;
      }
      setSpeechError(localizeNetworkError(err, t("app-tts-failed")));
      setSpeakingId(null);
      setSpeakingIndex(null);
    }

    let pending = fetchChunk(items[0].text);

    for (let i = 0; i < items.length; i++) {
      const result = await pending;
      if (generation !== playGenerationRef.current) return; // superseded by stop()/another speak()

      // Start the next chunk's fetch immediately, before/while this chunk
      // plays — that overlap is the entire point of the pipeline.
      const next = i + 1 < items.length ? fetchChunk(items[i + 1].text) : null;

      if ("error" in result) {
        fallbackOrFail(items.slice(i), result.error);
        return;
      }

      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      // Only the first chunk shows as "loading"; gaps waiting on a
      // not-yet-ready prefetch keep speakingId set instead of bouncing back.
      setLoadingId(null);
      setSpeakingId(id);
      setSpeakingIndex(items[i].index);

      const playbackFailed = await new Promise<boolean>((resolve) => {
        stopSignalRef.current = () => resolve(true);
        audio.onended = () => resolve(false);
        audio.onerror = () => resolve(true);
        audio.play().catch(() => resolve(true));
      });
      stopSignalRef.current = null;
      if (generation !== playGenerationRef.current) return; // stop()'d mid-playback, not a real failure

      if (playbackFailed) {
        fallbackOrFail(items.slice(i), new Error("audio playback failed"));
        return;
      }

      if (next) pending = next;
    }

    if (generation === playGenerationRef.current) {
      setSpeakingId(null);
      setSpeakingIndex(null);
    }
  }

  function speak(text: string, language: string, id: string): void {
    if (!supported || !text.trim()) return;

    if (speakingId === id || loadingId === id) {
      stop();
      return;
    }

    stop();

    const config = loadLlmConfig() ?? emptyLlmConfig();
    const engine = deriveVoiceEngine(config, "tts");
    const lang = languageBcp47Tag(language);
    const ttsVoiceByLanguage = loadSettings().ttsVoiceByLanguage;
    const voiceOverride = resolveVoiceOverride(ttsVoiceByLanguage, lang);

    if (engine === "network") {
      const roomId = config.network.roomId;
      if (roomId.trim()) {
        const model = networkVoiceModelParam(config.tts?.model ?? "");
        const resolved = resolveNetworkVoice(ttsVoiceByLanguage, config.tts?.voice, lang);
        logNetworkTtsRequest(lang, resolved.voice, resolved.source, model, text, describeVoiceProviderResolution(config, "tts"));
        void playFromSource(
          () =>
            requestNetworkTts(roomId, {
              text,
              model,
              voice: resolved.voice,
              lang,
            }),
          text,
          lang,
          id,
        );
        return;
      }
      // Not configured (no room id) — fall back silently, no attempt was made.
      speakWithBrowser(text, lang, id);
      return;
    }

    if (engine === "api") {
      const target = resolveVoice(config, "tts");
      if (target) {
        const resolvedTarget = voiceOverride ? { ...target, voice: voiceOverride } : target;
        logApiTtsRequest(lang, resolvedTarget.voice, resolvedTarget.model, text, describeVoiceProviderResolution(config, "tts"));
        void playFromSource(() => synthesizeSpeechApi(text, resolvedTarget), text, lang, id);
        return;
      }
      // Not configured (no resolved voice) — fall back silently.
      speakWithBrowser(text, lang, id);
      return;
    }

    speakWithBrowser(text, lang, id);
  }

  function speakSequence(texts: string[], language: string, id: string): void {
    if (!supported) return;

    const items: SequenceItem[] = texts
      .map((text, index) => ({ text, index }))
      .filter((item) => item.text.trim().length > 0);
    if (items.length === 0) return;

    if (speakingId === id || loadingId === id) {
      stop();
      return;
    }

    stop();

    const config = loadLlmConfig() ?? emptyLlmConfig();
    const engine = deriveVoiceEngine(config, "tts");
    const lang = languageBcp47Tag(language);
    const ttsVoiceByLanguage = loadSettings().ttsVoiceByLanguage;
    const voiceOverride = resolveVoiceOverride(ttsVoiceByLanguage, lang);

    if (engine === "network") {
      const roomId = config.network.roomId;
      if (roomId.trim()) {
        const model = networkVoiceModelParam(config.tts?.model ?? "");
        const resolved = resolveNetworkVoice(ttsVoiceByLanguage, config.tts?.voice, lang);
        // voice/lang/model are constant across every chunk of the sequence —
        // only the text itself changes per request — so one log line here
        // (previewing the first chunk) covers the whole sequence instead of
        // repeating per chunk.
        logNetworkTtsRequest(
          lang,
          resolved.voice,
          resolved.source,
          model,
          items[0]?.text ?? "",
          describeVoiceProviderResolution(config, "tts"),
        );
        void playSequenceFromSource(
          (text) =>
            requestNetworkTts(roomId, {
              text,
              model,
              voice: resolved.voice,
              lang,
            }),
          items,
          lang,
          id,
        );
        return;
      }
      // Not configured (no room id) — fall back silently, no attempt was made.
      playSequenceWithBrowser(items, lang, id);
      return;
    }

    if (engine === "api") {
      const target = resolveVoice(config, "tts");
      if (target) {
        const resolvedTarget = voiceOverride ? { ...target, voice: voiceOverride } : target;
        // See speak()'s equivalent log call: one line covers the whole
        // sequence since voice/model/provider are constant across chunks.
        logApiTtsRequest(
          lang,
          resolvedTarget.voice,
          resolvedTarget.model,
          items[0]?.text ?? "",
          describeVoiceProviderResolution(config, "tts"),
        );
        void playSequenceFromSource((text) => synthesizeSpeechApi(text, resolvedTarget), items, lang, id);
        return;
      }
      // Not configured (no resolved voice) — fall back silently.
      playSequenceWithBrowser(items, lang, id);
      return;
    }

    playSequenceWithBrowser(items, lang, id);
  }

  return { supported, speakingId, loadingId, speakingIndex, speechError, speak, speakSequence, stop };
}
