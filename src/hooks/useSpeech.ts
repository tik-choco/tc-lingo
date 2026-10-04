// Read-aloud uses the resolved shared TTS ref and its local language voices.
// API and room audio are pipelined; playback failures fall back to the browser.
import { useEffect, useRef, useState } from "preact/hooks";
import { emptyLlmConfig, loadLlmConfig, resolveVoice, subscribeLlmConfig } from "../lib/llmConfig";
import type { SharedLlmConfigV1 } from "../lib/llmConfig";
import { languageBcp47Tag } from "../lib/languages";
import { localizeNetworkError, rooms, requestNetworkTts } from "../lib/network";
import { isNetworkProviderBaseUrl, networkVoiceModelParam, roomIdFromBaseUrl } from "../lib/llmConfig";
import { loadSettings, subscribeSettings, voiceRefKey } from "../lib/settings";
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

// Report the actual resolved room without exposing keys or HTTP query strings.
function logTtsFailureDiagnostics(err: unknown): void {
  const target = resolveVoice(loadLlmConfig() ?? emptyLlmConfig(), "tts");
  console.warn("[useSpeech] TTS request failed; falling back to the browser voice.", err, {
    consumerStatus: target && isNetworkProviderBaseUrl(target.baseUrl)
      ? rooms.roomConsumer(roomIdFromBaseUrl(target.baseUrl)).status : undefined,
  });
}

type VoiceProviderSource = "explicit" | "defaultModel" | "unresolved";

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
  const target = resolveVoice(config, kind);
  return target ? {
    providerSource: config[kind]?.providerId === target.providerId ? "explicit" : "defaultModel",
    baseUrlHost: baseUrlHostForLog(target.baseUrl),
  } : { providerSource: "unresolved" };
}

/** DevTools-only diagnostic for exactly what's about to go out over the AI
 * Network room for a "network" engine TTS request — the single most useful
 * thing to check when a learner reports "it's reading English in a Japanese
 * voice" (or vice versa): was a per-language override in play, was the global
 * voice suppressed for a lang mismatch, and what actually got sent. See
 * lib/ttsVoiceByLanguage.ts's `resolveNetworkVoice` for the source values.
 * `providerSource`/`baseUrlHost` (see `describeVoiceProviderResolution`)
 * explain HOW `engine: "network"` was even reached — most usefully,
 * `providerSource: "defaultModel"` means this room ended up in the request
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
 * `tts.providerId` or (silently) from `config.defaultModelId` — see
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
  const roomConfigured = Boolean(resolveVoice(config, "tts"));
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
    const unsubscribeConfig = subscribeLlmConfig(refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      unsubscribeSettings();
      unsubscribeConfig();
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
    const voiceTarget = resolveVoice(config, "tts");
    const ttsVoiceByLanguage = voiceTarget ? loadSettings().ttsVoicesByRef[voiceRefKey(voiceTarget)] : undefined;
    const voiceOverride = resolveVoiceOverride(ttsVoiceByLanguage, lang);

    if (engine === "network") {
      const roomId = roomIdFromBaseUrl(resolveVoice(config, "tts")?.baseUrl ?? "");
      if (roomId.trim()) {
        const model = networkVoiceModelParam(voiceTarget?.model ?? "");
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
    const voiceTarget = resolveVoice(config, "tts");
    const ttsVoiceByLanguage = voiceTarget ? loadSettings().ttsVoicesByRef[voiceRefKey(voiceTarget)] : undefined;
    const voiceOverride = resolveVoiceOverride(ttsVoiceByLanguage, lang);

    if (engine === "network") {
      const roomId = roomIdFromBaseUrl(resolveVoice(config, "tts")?.baseUrl ?? "");
      if (roomId.trim()) {
        const model = networkVoiceModelParam(voiceTarget?.model ?? "");
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
