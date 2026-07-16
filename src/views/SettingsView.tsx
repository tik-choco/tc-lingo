import { useEffect, useState } from "preact/hooks";
import { Sparkles, X } from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { ensurePreset, ensureProvider, loadLlmConfig, saveLlmConfig } from "../lib/llmConfig";
import { addTargetLanguage, loadSettings, removeTargetLanguage, saveSettings, subscribeSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { requestOnboarding } from "../lib/onboarding";
import { useLlmPreset } from "../hooks/useLlmPreset";

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
      setError(e instanceof Error ? e.message : "モデル一覧の取得に失敗しました。");
    } finally {
      setFetchingModels(false);
    }
  }

  function addConnection(event: Event) {
    event.preventDefault();
    if (!baseUrl.trim() || !model.trim()) {
      setError("接続先URLとモデル名は必須です。");
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
        <h2>はじめに</h2>
        <p class="hint-text">初回起動時のセットアップガイドをもう一度表示できます。</p>
        <div class="button-row">
          <button type="button" onClick={requestOnboarding}>
            <Sparkles size={15} />
            セットアップガイドを表示
          </button>
        </div>
      </section>

      <section class="card-panel">
        <h2>学習言語</h2>
        <div class="field-grid">
          <div class="field-grid">
            <label>学習中の言語</label>
            <div class="language-chip-list">
              {settings.targetLanguages.map((lang) => (
                <span class="language-chip" key={lang}>
                  {languageDisplayName(lang)}
                  <button
                    type="button"
                    disabled={settings.targetLanguages.length <= 1}
                    title="削除"
                    aria-label={`${languageDisplayName(lang)}を削除`}
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
              placeholder="言語を追加"
              ariaLabel="学習言語を追加"
            />
          </div>
          <label>
            母語(説明に使う言語)
            <LanguageSelect
              value={settings.nativeLanguage}
              onChange={(lang) => updateLanguage({ nativeLanguage: lang })}
              ariaLabel="母語を選択"
            />
          </label>
        </div>
      </section>

      <section class="card-panel">
        <h2>LLM接続</h2>
        <p class="hint-text">
          tik-choco の他アプリと共有する接続設定です。一度設定すれば TC Lingo 以外のアプリでも同じ接続を使えます。
        </p>

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
          <p class="hint-text status-ok">現在の接続先: {target.label}({target.model})</p>
        ) : (
          <p class="hint-text status-warn">まだLLM接続が設定されていません。下のフォームから追加してください。</p>
        )}

        <form class="field-grid" onSubmit={addConnection}>
          <label>
            ラベル(任意)
            <input type="text" value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} placeholder="例: OpenAI" />
          </label>
          <label>
            接続先URL(baseUrl)
            <input type="text" value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            APIキー
            <input type="password" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            モデル名
            <div class="model-row">
              <input
                type="text"
                list="tc-lingo-model-options"
                value={model}
                onInput={(e) => setModel((e.target as HTMLInputElement).value)}
                placeholder="例: gpt-4.1-mini"
              />
              <datalist id="tc-lingo-model-options">
                {modelOptions.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <button type="button" onClick={loadModelOptions} disabled={fetchingModels}>
                {fetchingModels ? "取得中…" : "モデル一覧を取得"}
              </button>
            </div>
          </label>
          {error && <p class="error-text">{error}</p>}
          <button type="submit" class="primary-button">
            この接続を追加して使う
          </button>
        </form>
      </section>
    </div>
  );
}
