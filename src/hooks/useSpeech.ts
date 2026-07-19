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
import { emptyLlmConfig, loadLlmConfig, resolveVoice } from "../lib/llmConfig";
import { languageBcp47Tag } from "../lib/languages";
import { localizeNetworkError, requestNetworkTts } from "../lib/network";
import { networkVoiceModelParam } from "../lib/networkModels";
import { subscribeSettings } from "../lib/settings";
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
        setSpeechError(t("app-tts-fallback-browser"));
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
        setSpeechError(t("app-tts-fallback-browser"));
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

    if (engine === "network") {
      const roomId = config.network.roomId;
      if (roomId.trim()) {
        void playFromSource(
          () =>
            requestNetworkTts(roomId, { text, model: networkVoiceModelParam(config.tts?.model ?? ""), voice: config.tts?.voice }),
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
        void playFromSource(() => synthesizeSpeechApi(text, target), text, lang, id);
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

    if (engine === "network") {
      const roomId = config.network.roomId;
      if (roomId.trim()) {
        void playSequenceFromSource(
          (text) =>
            requestNetworkTts(roomId, { text, model: networkVoiceModelParam(config.tts?.model ?? ""), voice: config.tts?.voice }),
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
        void playSequenceFromSource((text) => synthesizeSpeechApi(text, target), items, lang, id);
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
