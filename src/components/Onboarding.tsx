// First-run wizard shown by app.tsx as a modal overlay: welcome -> LLM
// connection -> language pair -> feature tour. Every step is skippable and
// closing at any point counts as "done" (the flag is owned by the caller via
// `onClose`) — the settings screen can re-open it any time. Same shape as
// tc-town's Onboarding.tsx, adapted to this app's own tokens/content.
import { useState } from "preact/hooks";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  History,
  Languages,
  Layers,
  PenLine,
  Plug,
  Repeat2,
  Sparkles,
  X,
} from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { ensurePreset, ensureProvider, loadLlmConfig, saveLlmConfig } from "../lib/llmConfig";
import { testConnection } from "../lib/llm";
import { addTargetLanguage, loadSettings, removeTargetLanguage, saveSettings } from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "./LanguageSelect";
import { t } from "../i18n";
import "../styles/onboarding.css";

const STEP_COUNT = 4;

interface LlmDraft {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type TestState = { phase: "idle" } | { phase: "busy" } | { phase: "ok" } | { phase: "error"; message: string };

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

export function Onboarding(props: { onClose: () => void }) {
  const [step, setStep] = useState(0);

  const [llm, setLlm] = useState<LlmDraft>({ baseUrl: "https://api.openai.com/v1", apiKey: "", model: "" });
  const [testState, setTestState] = useState<TestState>({ phase: "idle" });
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const [langSettings, setLangSettings] = useState(loadSettings);

  function updateLlm(patch: Partial<LlmDraft>) {
    setLlm((prev) => ({ ...prev, ...patch }));
    setTestState({ phase: "idle" });
  }

  async function loadModelOptions() {
    setFetchingModels(true);
    try {
      const ids = await fetchModels({ baseUrl: llm.baseUrl, apiKey: llm.apiKey });
      setModelOptions(ids);
      if (!llm.model && ids.length > 0) updateLlm({ model: ids[0] });
    } catch {
      // Non-fatal — the model field stays free text either way.
    } finally {
      setFetchingModels(false);
    }
  }

  async function handleTest() {
    if (testState.phase === "busy") return;
    setTestState({ phase: "busy" });
    try {
      await testConnection(llm);
      setTestState({ phase: "ok" });
    } catch (error) {
      setTestState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Persists the draft as (or into) the shared config's default preset —
   * this is the connection every tik-choco app on the origin will offer by
   * default afterwards. */
  function saveLlmDraft() {
    if (!llm.baseUrl.trim() || !llm.model.trim()) return;
    const current = loadLlmConfig() ?? {
      v: 1 as const,
      providers: [],
      presets: [],
      defaultPresetId: "",
      network: { roomId: "" },
      updatedAt: "",
    };
    const providerId = ensureProvider(current, { baseUrl: llm.baseUrl, apiKey: llm.apiKey });
    const presetId = ensurePreset(current, { providerId, model: llm.model });
    if (!current.defaultPresetId) current.defaultPresetId = presetId;
    saveLlmConfig(current);
    saveSettings({ ...loadSettings(), presetId });
  }

  function handleLlmNext() {
    saveLlmDraft();
    setStep(2);
  }

  function handleLanguageNext() {
    setStep(3);
  }

  return (
    <div class="ob-overlay">
      <div class="ob-card" role="dialog" aria-modal="true" aria-label={t("ob-dialog-label")}>
        <button class="ob-close" type="button" onClick={props.onClose} title={t("ob-close")} aria-label={t("ob-close")}>
          <X size={18} />
        </button>

        {step === 0 && (
          <div class="ob-body">
            <div class="ob-hero">
              <Sparkles size={36} />
            </div>
            <h2 class="ob-title">{t("ob-welcome-title")}</h2>
            <p class="ob-text">{t("ob-welcome-body-1")}</p>
            <p class="ob-text">
              {t("ob-welcome-body-2-pre")}
              <strong>{t("ob-welcome-llm")}</strong>
              {t("ob-welcome-and")}
              <strong>{t("ob-welcome-lang")}</strong>
              {t("ob-welcome-body-2-post")}
            </p>
          </div>
        )}

        {step === 1 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Cpu size={22} />
              <h2 class="ob-title">{t("ob-llm-title")}</h2>
            </div>
            <p class="ob-text">{t("ob-llm-body")}</p>

            <div class="ob-field">
              <label class="ob-label">{t("ob-llm-base-url-label")}</label>
              <input
                class="ob-input"
                type="text"
                placeholder={t("ob-llm-base-url-placeholder")}
                value={llm.baseUrl}
                onInput={(e) => updateLlm({ baseUrl: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t("ob-llm-api-key-label")}</label>
              <input
                class="ob-input"
                type="password"
                placeholder={t("ob-llm-api-key-placeholder")}
                value={llm.apiKey}
                onInput={(e) => updateLlm({ apiKey: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t("ob-llm-model-label")}</label>
              <div class="ob-model-row">
                <input
                  class="ob-input"
                  type="text"
                  list="ob-model-options"
                  placeholder={t("ob-llm-model-placeholder")}
                  value={llm.model}
                  onInput={(e) => updateLlm({ model: inputValue(e) })}
                />
                <datalist id="ob-model-options">
                  {modelOptions.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <button
                  class="ob-icon-btn"
                  type="button"
                  onClick={loadModelOptions}
                  disabled={fetchingModels || !llm.baseUrl.trim()}
                  title={t("ob-llm-fetch-title")}
                >
                  {fetchingModels ? t("ob-llm-fetch-busy") : t("ob-llm-fetch-label")}
                </button>
              </div>
            </div>

            <div class="ob-test-row">
              <button
                class="ob-btn"
                type="button"
                onClick={() => void handleTest()}
                disabled={testState.phase === "busy" || !llm.baseUrl.trim() || !llm.model.trim()}
              >
                {testState.phase === "busy" ? <span class="spinner" /> : <Plug size={16} />}
                {testState.phase === "busy" ? t("ob-llm-test-busy") : t("ob-llm-test-button")}
              </button>
              {testState.phase === "ok" && (
                <span class="ob-test-ok">
                  <Check size={16} />
                  {t("ob-llm-test-ok")}
                </span>
              )}
            </div>
            {testState.phase === "error" && (
              <p class="ob-error">{t("ob-llm-test-error", { message: testState.message })}</p>
            )}
          </div>
        )}

        {step === 2 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Languages size={22} />
              <h2 class="ob-title">{t("ob-lang-title")}</h2>
            </div>
            <p class="ob-text">{t("ob-lang-body")}</p>
            <div class="ob-field">
              <label class="ob-label">{t("ob-lang-target-label")}</label>
              <div class="language-chip-list">
                {langSettings.targetLanguages.map((lang) => (
                  <span class="language-chip" key={lang}>
                    {languageDisplayName(lang)}
                    <button
                      type="button"
                      disabled={langSettings.targetLanguages.length <= 1}
                      title={t("ob-lang-remove-title")}
                      aria-label={t("ob-remove-language", { language: languageDisplayName(lang) })}
                      onClick={() => {
                        removeTargetLanguage(lang);
                        setLangSettings(loadSettings());
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
                  setLangSettings(loadSettings());
                }}
                exclude={langSettings.targetLanguages}
                placeholder={t("ob-lang-add-placeholder")}
                ariaLabel={t("ob-lang-add-aria")}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t("ob-lang-native-label")}</label>
              <LanguageSelect
                value={langSettings.nativeLanguage}
                onChange={(lang) => {
                  const next = { ...loadSettings(), nativeLanguage: lang };
                  saveSettings(next);
                  setLangSettings(next);
                }}
                ariaLabel={t("ob-lang-native-aria")}
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Check size={22} />
              <h2 class="ob-title">{t("ob-done-title")}</h2>
            </div>
            <ul class="ob-feature-list">
              <li>
                <PenLine size={16} />
                <span>
                  <strong>{t("ob-feature-practice-label")}</strong> {t("ob-feature-practice-desc")}
                </span>
              </li>
              <li>
                <Repeat2 size={16} />
                <span>
                  <strong>{t("ob-feature-review-label")}</strong> {t("ob-feature-review-desc")}
                </span>
              </li>
              <li>
                <Layers size={16} />
                <span>
                  <strong>{t("ob-feature-cards-label")}</strong> {t("ob-feature-cards-desc")}
                </span>
              </li>
              <li>
                <History size={16} />
                <span>
                  <strong>{t("ob-feature-history-label")}</strong> {t("ob-feature-history-desc")}
                </span>
              </li>
            </ul>
            <p class="ob-text ob-text-subtle">{t("ob-done-footer")}</p>
          </div>
        )}

        <footer class="ob-footer">
          <div class="ob-dots" aria-hidden="true">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} class={"ob-dot" + (i === step ? " is-active" : "")} />
            ))}
          </div>
          <div class="ob-footer-actions">
            {step > 0 && step < 3 && (
              <button class="ob-btn" type="button" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} />
                {t("ob-back")}
              </button>
            )}
            {step === 0 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(1)}>
                {t("ob-start")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 1 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLlmNext}>
                {t("ob-save-next")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLanguageNext}>
                {t("ob-save-next")}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 3 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={props.onClose}>
                <Check size={16} />
                {t("ob-finish")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
