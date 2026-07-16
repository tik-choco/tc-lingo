import { useEffect, useState } from "preact/hooks";
import { Sparkles, X } from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { ensurePreset, ensureProvider, loadLlmConfig, saveLlmConfig } from "../lib/llmConfig";
import { addTargetLanguage, loadSettings, removeTargetLanguage, saveSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { requestOnboarding } from "../lib/onboarding";
import { useLlmPreset } from "../hooks/useLlmPreset";
import { t } from "../i18n";

export function SettingsView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const { config, target } = useLlmPreset();

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
      </section>
    </div>
  );
}
