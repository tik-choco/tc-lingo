import { useEffect, useRef, useState } from "preact/hooks";
import { Network, Server, Sparkles, Volume2, X } from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import {
  emptyLlmConfig,
  ensurePreset,
  ensureProvider,
  loadLlmConfig,
  saveLlmConfig,
  subscribeLlmConfig,
} from "../lib/llmConfig";
import type { SharedLlmConfigV1, VoiceConfigV1 } from "../lib/llmConfig";
import { OPENAI_TTS_VOICES, fetchVoices } from "../lib/voices";
import {
  addTargetLanguage,
  loadSettings,
  removeTargetLanguage,
  saveSettings,
  setConnectionMode,
  setTtsEngine,
  subscribeSettings,
} from "../lib/settings";
import { setSharedNetworkRoomId } from "../lib/llmConnection";
import { localizeConsumerError } from "../lib/network";
import type { ConsumerStatus } from "../lib/network";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { requestOnboarding } from "../lib/onboarding";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { useNetworkConsumerStatusWithTimestamp } from "../hooks/useNetworkConsumerStatus";
import { useSpeech } from "../hooks/useSpeech";
import { t } from "../i18n";

// Short greeting used by the TTS "test playback" button, one per commonly
// supported target language (see lib/languages.ts's languageOptions). A
// language without an entry here falls back to the English sentence — the
// engine just speaks whatever text it's given, so this is a legibility
// tradeoff (the sample won't be in the learner's target script) rather than
// a functional limitation.
const TTS_SAMPLE_TEXT: Record<string, string> = {
  English: "Hello, nice to meet you.",
  Japanese: "こんにちは、はじめまして。",
  Korean: "안녕하세요, 만나서 반갑습니다.",
  "Chinese (Simplified)": "你好,很高兴认识你。",
  "Chinese (Traditional)": "你好,很高興認識你。",
  Spanish: "Hola, mucho gusto.",
  French: "Bonjour, enchanté.",
  German: "Hallo, freut mich.",
};

const TTS_TEST_ID = "settings-tts-test";

// Step order for the AI Network connection status display (未接続 → Room接続中
// → provider探索中 → 接続済み). "error" is a terminal state handled separately
// (see networkStepIndex).
const NETWORK_STEPS: Array<{ phase: Exclude<ConsumerStatus["phase"], "error">; labelKey: string }> = [
  { phase: "idle", labelKey: "settings-network-status-idle" },
  { phase: "joining", labelKey: "settings-network-status-joining" },
  { phase: "searching", labelKey: "settings-network-status-searching" },
  { phase: "connected", labelKey: "settings-network-status-connected" },
];

function networkStepIndex(phase: ConsumerStatus["phase"]): number {
  if (phase === "error") return -1;
  return NETWORK_STEPS.findIndex((step) => step.phase === phase);
}

export function SettingsView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const { config, target, mode, roomId } = useLlmConnection();
  const { status, updatedAt } = useNetworkConsumerStatusWithTimestamp();
  const currentStepIndex = networkStepIndex(status.phase);

  // Local draft for the Room ID field: mirrors `roomId` from the shared
  // config until the user focuses the input, then holds their in-progress
  // edit and commits on blur (same-tab writes to the shared llm config don't
  // self-notify — see lib/llmConfig.ts — so this also keeps what the user
  // just typed visible even before any refresh).
  const [roomIdDraft, setRoomIdDraft] = useState(roomId);
  const roomIdFocused = useRef(false);
  useEffect(() => {
    if (!roomIdFocused.current) setRoomIdDraft(roomId);
  }, [roomId]);

  function commitRoomId() {
    roomIdFocused.current = false;
    setSharedNetworkRoomId(roomIdDraft);
  }

  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [error, setError] = useState("");

  // ----- TTS (音声読み上げ) ---------------------------------------------------
  // Local mirror of the shared llm config, kept in sync with our own writes
  // (updateTts) plus cross-tab writes (subscribeLlmConfig). Same-tab writes to
  // tc-shared-llm-config-v1 don't self-notify (see llmConfig.ts), so `config`
  // from useLlmConnection above can't be reused here without adding a
  // dependency on that hook's refresh path.
  const [sharedConfig, setSharedConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  useEffect(() => subscribeLlmConfig((cfg) => setSharedConfig(cfg ?? emptyLlmConfig())), []);
  const [ttsVoiceOptions, setTtsVoiceOptions] = useState<string[]>(OPENAI_TTS_VOICES);
  const [fetchingTtsVoices, setFetchingTtsVoices] = useState(false);
  const speech = useSpeech();

  function updateTts(patch: Partial<VoiceConfigV1>) {
    const current = loadLlmConfig() ?? emptyLlmConfig();
    const currentTts: VoiceConfigV1 = current.tts ?? { model: "" };
    current.tts = { ...currentTts, ...patch };
    saveLlmConfig(current);
    setSharedConfig(current);
  }

  // TTS falls back to the default preset's provider when it doesn't specify
  // its own (see resolveVoice() in lib/llmConfig.ts) — mirror that here so
  // the voice-fetch button targets the right endpoint.
  const ttsProviderId =
    sharedConfig.tts?.providerId || sharedConfig.presets.find((p) => p.id === sharedConfig.defaultPresetId)?.providerId;
  const ttsProvider = sharedConfig.providers.find((p) => p.id === ttsProviderId);

  async function loadTtsVoiceOptions() {
    if (settings.ttsEngine !== "api" || !ttsProvider?.baseUrl) {
      setTtsVoiceOptions(OPENAI_TTS_VOICES);
      return;
    }
    setFetchingTtsVoices(true);
    try {
      const voices = await fetchVoices({ baseUrl: ttsProvider.baseUrl, apiKey: ttsProvider.apiKey });
      setTtsVoiceOptions(voices);
    } catch {
      setTtsVoiceOptions(OPENAI_TTS_VOICES);
    } finally {
      setFetchingTtsVoices(false);
    }
  }

  function handleTestSpeak() {
    const sample = TTS_SAMPLE_TEXT[settings.activeLanguage] ?? TTS_SAMPLE_TEXT.English;
    speech.speak(sample, settings.activeLanguage, TTS_TEST_ID);
  }

  function updateLanguage(patch: Partial<typeof settings>) {
    const next = { ...loadSettings(), ...patch };
    setSettings(next);
    saveSettings(next);
  }

  function selectPreset(presetId: string) {
    updateLanguage({ presetId });
  }

  async function loadModelOptions() {
    setError("");
    setFetchingModels(true);
    try {
      const ids = await fetchModels({ baseUrl, apiKey });
      setModelOptions(ids);
      if (!model && ids.length > 0) setModel(ids[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings-fetch-models-error"));
    } finally {
      setFetchingModels(false);
    }
  }

  function addConnection(event: Event) {
    event.preventDefault();
    if (!baseUrl.trim() || !model.trim()) {
      setError(t("settings-validation-required"));
      return;
    }
    const current = loadLlmConfig() ?? {
      v: 1 as const,
      providers: [],
      presets: [],
      defaultPresetId: "",
      network: { roomId: "" },
      updatedAt: "",
    };
    const providerId = ensureProvider(current, { label: label || undefined, baseUrl, apiKey });
    const presetId = ensurePreset(current, { label: label || model, providerId, model });
    if (!current.defaultPresetId) current.defaultPresetId = presetId;
    saveLlmConfig(current);
    updateLanguage({ presetId });
    setLabel("");
    setApiKey("");
    setModel("");
    setModelOptions([]);
    setError("");
  }

  return (
    <div class="view-container settings-view">
      <section class="card-panel">
        <h2>{t("settings-getting-started-heading")}</h2>
        <p class="hint-text">{t("settings-getting-started-hint")}</p>
        <div class="button-row">
          <button type="button" onClick={requestOnboarding}>
            <Sparkles size={15} />
            {t("settings-show-onboarding-button")}
          </button>
        </div>
      </section>

      <section class="card-panel">
        <h2>{t("settings-target-language-heading")}</h2>
        <div class="field-grid">
          <div class="field-grid">
            <label>{t("settings-target-language-label")}</label>
            <div class="language-chip-list">
              {settings.targetLanguages.map((lang) => (
                <span class="language-chip" key={lang}>
                  {languageDisplayName(lang)}
                  <button
                    type="button"
                    disabled={settings.targetLanguages.length <= 1}
                    title={t("settings-remove-language-title")}
                    aria-label={t("settings-remove-language", { language: languageDisplayName(lang) })}
                    onClick={() => {
                      removeTargetLanguage(lang);
                      setSettings(loadSettings());
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <LanguageSelect
              value=""
              onChange={(lang) => {
                addTargetLanguage(lang);
                setSettings(loadSettings());
              }}
              exclude={settings.targetLanguages}
              placeholder={t("settings-add-language-placeholder")}
              ariaLabel={t("settings-add-language-aria-label")}
            />
          </div>
          <label>
            {t("settings-native-language-label")}
            <LanguageSelect
              value={settings.nativeLanguage}
              onChange={(lang) => updateLanguage({ nativeLanguage: lang })}
              ariaLabel={t("settings-native-language-aria-label")}
            />
          </label>
          <p class="hint-text">{t("settings-native-language-hint")}</p>
        </div>
      </section>

      <section class="card-panel">
        <h2>{t("settings-llm-heading")}</h2>
        <p class="hint-text">{t("settings-llm-hint")}</p>

        <div class="connection-mode-toggle" role="radiogroup" aria-label={t("settings-connection-mode-label")}>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "api"}
            class={`connection-mode-button${mode === "api" ? " connection-mode-button-active" : ""}`}
            onClick={() => setConnectionMode("api")}
          >
            <Server size={14} />
            {t("settings-connection-mode-api")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "network"}
            class={`connection-mode-button${mode === "network" ? " connection-mode-button-active" : ""}`}
            onClick={() => setConnectionMode("network")}
          >
            <Network size={14} />
            {t("settings-connection-mode-network")}
          </button>
        </div>
        <p class="hint-text">{t("settings-connection-mode-hint")}</p>

        {mode === "network" ? (
          <div class="network-panel">
            <label>
              {t("settings-network-roomid-label")}
              <input
                type="text"
                value={roomIdDraft}
                onFocus={() => {
                  roomIdFocused.current = true;
                }}
                onInput={(e) => setRoomIdDraft((e.target as HTMLInputElement).value)}
                onBlur={commitRoomId}
                placeholder={t("settings-network-roomid-placeholder")}
              />
            </label>
            <p class="hint-text">{t("settings-network-roomid-hint")}</p>

            <div class={`network-status${status.phase === "error" ? " network-status-error" : ""}`}>
              <ol class="network-status-steps">
                {NETWORK_STEPS.map((step, i) => {
                  const stepClass =
                    status.phase === "error" ? "" : i < currentStepIndex ? " done" : i === currentStepIndex ? " current" : "";
                  return (
                    <li key={step.phase} class={`network-status-step${stepClass}`}>
                      {t(step.labelKey)}
                    </li>
                  );
                })}
              </ol>
              {status.phase === "error" ? (
                <p class="error-text">
                  {localizeConsumerError(status, t("settings-network-status-error-fallback"))}
                </p>
              ) : null}
              {updatedAt > 0 ? (
                <p class="hint-text network-status-timestamp">
                  {t("settings-network-status-updated", { time: new Date(updatedAt).toLocaleTimeString() })}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {config && config.presets.length > 0 && (
              <div class="preset-list">
                {config.presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    class={`preset-item${settings.presetId === preset.id || (!settings.presetId && preset.id === config.defaultPresetId) ? " preset-item-active" : ""}`}
                    onClick={() => selectPreset(preset.id)}
                  >
                    <span class="preset-item-label">{preset.label}</span>
                    <span class="preset-item-model">{preset.model}</span>
                  </button>
                ))}
              </div>
            )}

            {target ? (
              <p class="hint-text status-ok">
                {t("settings-llm-current-connection", { label: target.label, model: target.model })}
              </p>
            ) : (
              <p class="hint-text status-warn">{t("settings-llm-no-connection")}</p>
            )}

            <form class="field-grid" onSubmit={addConnection}>
              <label>
                {t("settings-label-field-label")}
                <input
                  type="text"
                  value={label}
                  onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
                  placeholder={t("settings-label-placeholder")}
                />
              </label>
              <label>
                {t("settings-baseurl-field-label")}
                <input type="text" value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
              </label>
              <label>
                {t("settings-apikey-field-label")}
                <input type="password" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
              </label>
              <label>
                {t("settings-model-field-label")}
                <div class="model-row">
                  <input
                    type="text"
                    list="tc-lingo-model-options"
                    value={model}
                    onInput={(e) => setModel((e.target as HTMLInputElement).value)}
                    placeholder={t("settings-model-placeholder")}
                  />
                  <datalist id="tc-lingo-model-options">
                    {modelOptions.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <button type="button" onClick={loadModelOptions} disabled={fetchingModels}>
                    {fetchingModels ? t("settings-fetch-models-loading") : t("settings-fetch-models-button")}
                  </button>
                </div>
              </label>
              {error && <p class="error-text">{error}</p>}
              <button type="submit" class="primary-button">
                {t("settings-add-connection-button")}
              </button>
            </form>
          </>
        )}
      </section>

      <section class="card-panel">
        <h2 class="settings-tts-heading">
          <Volume2 size={16} />
          {t("settings-tts-heading")}
        </h2>
        <p class="hint-text">{t("settings-tts-hint")}</p>

        <div class="connection-mode-toggle" role="radiogroup" aria-label={t("settings-tts-engine-label")}>
          <button
            type="button"
            role="radio"
            aria-checked={settings.ttsEngine === "browser"}
            class={`connection-mode-button${settings.ttsEngine === "browser" ? " connection-mode-button-active" : ""}`}
            onClick={() => setTtsEngine("browser")}
          >
            {t("settings-tts-engine-browser")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings.ttsEngine === "api"}
            class={`connection-mode-button${settings.ttsEngine === "api" ? " connection-mode-button-active" : ""}`}
            onClick={() => setTtsEngine("api")}
          >
            {t("settings-tts-engine-api")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings.ttsEngine === "network"}
            class={`connection-mode-button${settings.ttsEngine === "network" ? " connection-mode-button-active" : ""}`}
            onClick={() => setTtsEngine("network")}
          >
            {t("settings-tts-engine-network")}
          </button>
        </div>
        <p class="hint-text">
          {settings.ttsEngine === "browser"
            ? t("settings-tts-engine-hint-browser")
            : settings.ttsEngine === "api"
              ? t("settings-tts-engine-hint-api")
              : t("settings-tts-engine-hint-network")}
        </p>

        {settings.ttsEngine !== "browser" ? (
          <div class="field-grid">
            <p class="hint-text">{t("settings-tts-shared-hint")}</p>

            {settings.ttsEngine === "api" ? (
              <label>
                {t("settings-tts-provider-label")}
                <select
                  value={sharedConfig.tts?.providerId ?? ""}
                  onChange={(e) => updateTts({ providerId: (e.target as HTMLSelectElement).value || undefined })}
                >
                  <option value="">{t("settings-tts-provider-follow-default")}</option>
                  {sharedConfig.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label || p.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label>
              {t("settings-tts-model-label")}
              <input
                type="text"
                value={sharedConfig.tts?.model ?? ""}
                onInput={(e) => updateTts({ model: (e.target as HTMLInputElement).value })}
                placeholder={t("settings-tts-model-placeholder")}
              />
            </label>

            <label>
              {t("settings-tts-voice-label")}
              <div class="model-row">
                <input
                  type="text"
                  list="tc-lingo-tts-voice-options"
                  value={sharedConfig.tts?.voice ?? ""}
                  onInput={(e) => updateTts({ voice: (e.target as HTMLInputElement).value })}
                  placeholder={t("settings-tts-voice-placeholder")}
                />
                <datalist id="tc-lingo-tts-voice-options">
                  {ttsVoiceOptions.map((voice) => (
                    <option key={voice} value={voice} />
                  ))}
                </datalist>
                <button type="button" onClick={loadTtsVoiceOptions} disabled={fetchingTtsVoices}>
                  {fetchingTtsVoices ? t("settings-fetch-models-loading") : t("settings-tts-voice-fetch-button")}
                </button>
              </div>
            </label>
          </div>
        ) : null}

        <div class="button-row">
          <button type="button" onClick={handleTestSpeak} disabled={!speech.supported}>
            <Volume2 size={15} />
            {speech.loadingId === TTS_TEST_ID
              ? t("settings-tts-test-loading")
              : speech.speakingId === TTS_TEST_ID
                ? t("settings-tts-test-stop")
                : t("settings-tts-test-button")}
          </button>
        </div>
        {!speech.supported ? <p class="hint-text">{t("settings-tts-test-unsupported")}</p> : null}
        {speech.speechError ? <p class="error-text">{speech.speechError}</p> : null}
      </section>
    </div>
  );
}
