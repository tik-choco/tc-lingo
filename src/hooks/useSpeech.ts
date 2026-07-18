// "Read this aloud" for any piece of learner-facing text (a card's front, an
// example sentence, a topic prompt, ...). Ported from tc-translate's
// hooks/useSpeech.ts, adapted to tc-lingo's shape: views here are
// self-contained (no props — see CLAUDE.md), so this hook takes no
// arguments and instead reads settings.ttsEngine (lib/settings.ts) and the
// shared llm config's `tts`/`network.roomId` (lib/llmConfig.ts) itself, once
// per speak() call, so a mid-session settings change always takes effect on
// the next play without needing a re-mount.
//
// Three engines, one id-keyed toggle API:
//   - "browser": the Web Speech API (speechSynthesis) directly.
//   - "api": an OpenAI-compatible `/audio/speech` endpoint, resolved via
//     resolveVoice(config, "tts") and fetched by lib/tts.ts's
//     synthesizeSpeechApi.
//   - "network": the same kind of endpoint, reached over the AI Network room
//     via lib/network.ts's requestNetworkTts.
// "api"/"network" both fall back to the browser voice: silently if they were
// simply unconfigured (no resolved voice / no room id), or with
// `speechError` set to a localized notice if a configured attempt actually
// failed (network error, non-OK response, ...). Calling speak() again with
// the same `id` that's currently speaking/loading toggles playback off
// (stop()), matching tc-translate's behavior.
import { useEffect, useRef, useState } from "preact/hooks";
import { emptyLlmConfig, loadLlmConfig, resolveVoice } from "../lib/llmConfig";
import { languageBcp47Tag } from "../lib/languages";
import { localizeNetworkError, requestNetworkTts } from "../lib/network";
import { loadSettings, subscribeSettings } from "../lib/settings";
import { synthesizeSpeechApi } from "../lib/tts";
import { t } from "../i18n";

export interface SpeechController {
  supported: boolean;
  speakingId: string | null;
  loadingId: string | null;
  speechError: string;
  speak(text: string, language: string, id: string): void;
  stop(): void;
}

function browserSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Whether *some* playback path is currently usable — the browser voice, or
 * a configured API/Network TTS target — independent of which engine
 * `settings.ttsEngine` currently selects (any of the three can be reached
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
  const [speechError, setSpeechError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // Bumped on every stop()/speak() so a slow (api/network) getBlob() that
  // resolves after the user moved on can't resurrect playback (or an error/
  // fallback) they already dismissed.
  const playGenerationRef = useRef(0);

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
      if (browserSpeechSupported()) window.speechSynthesis.cancel();
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function stop(): void {
    playGenerationRef.current += 1;
    if (browserSpeechSupported()) window.speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setSpeakingId(null);
    setLoadingId(null);
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

  function speak(text: string, language: string, id: string): void {
    if (!supported || !text.trim()) return;

    if (speakingId === id || loadingId === id) {
      stop();
      return;
    }

    stop();

    const settings = loadSettings();
    const config = loadLlmConfig() ?? emptyLlmConfig();
    const lang = languageBcp47Tag(language);

    if (settings.ttsEngine === "network") {
      const roomId = config.network.roomId;
      if (roomId.trim()) {
        void playFromSource(
          () => requestNetworkTts(roomId, { text, model: config.tts?.model, voice: config.tts?.voice }),
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

    if (settings.ttsEngine === "api") {
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

  return { supported, speakingId, loadingId, speechError, speak, stop };
}
