import { useEffect, useRef, useState } from "preact/hooks";
import { Network, Server, Sparkles, X } from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { ensurePreset, ensureProvider, loadLlmConfig, saveLlmConfig } from "../lib/llmConfig";
import {
  addTargetLanguage,
  loadSettings,
  removeTargetLanguage,
  saveSettings,
  setConnectionMode,
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
import { t } from "../i18n";

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
    </div>
  );
}
