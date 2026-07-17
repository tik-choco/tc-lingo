// First-run wizard shown by app.tsx as a modal overlay: welcome -> LLM
// connection -> language pair -> feature tour. Every step is skippable and
// closing at any point counts as "done" (the flag is owned by the caller via
// `onClose`) — the settings screen can re-open it any time. Same shape as
// tc-town's Onboarding.tsx, adapted to this app's own tokens/content.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  History,
  Languages,
  Layers,
  Network,
  PenLine,
  Plug,
  Repeat2,
  Sparkles,
  X,
} from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { ensurePreset, ensureProvider, loadLlmConfig, saveLlmConfig } from "../lib/llmConfig";
import { testConnection, testNetworkConnection } from "../lib/llm";
import { setSharedNetworkRoomId } from "../lib/llmConnection";
import { localizeNetworkError } from "../lib/network";
import { isEditableTarget, SHORTCUT_PRIORITY } from "../lib/keyboard";
import { useShortcuts } from "../hooks/useShortcuts";
import type { LlmConnectionMode } from "../types";
import {
  addTargetLanguage,
  loadSettings,
  removeTargetLanguage,
  saveSettings,
  setConnectionMode,
} from "../lib/settings";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "./LanguageSelect";
import { t } from "../i18n";
import "../styles/onboarding.css";

// Focusable elements considered for the wizard's Tab focus trap. Kept simple
// (no visibility computation beyond `disabled`/offsetParent) per the same
// convention as other modals in this app.
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
  );
}

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

  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const [connectionModeDraft, setConnectionModeDraft] = useState<LlmConnectionMode>(
    () => loadSettings().connectionMode,
  );

  const [llm, setLlm] = useState<LlmDraft>({ baseUrl: "https://api.openai.com/v1", apiKey: "", model: "" });
  const [testState, setTestState] = useState<TestState>({ phase: "idle" });
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  const [roomId, setRoomId] = useState(() => loadLlmConfig()?.network.roomId ?? "");
  const [networkTestState, setNetworkTestState] = useState<TestState>({ phase: "idle" });

  const [langSettings, setLangSettings] = useState(loadSettings);

  function selectConnectionMode(mode: LlmConnectionMode) {
    setConnectionModeDraft(mode);
    setTestState({ phase: "idle" });
    setNetworkTestState({ phase: "idle" });
  }

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

  async function handleTestNetwork() {
    if (networkTestState.phase === "busy") return;
    setNetworkTestState({ phase: "busy" });
    try {
      await testNetworkConnection(roomId);
      setNetworkTestState({ phase: "ok" });
    } catch (error) {
      setNetworkTestState({ phase: "error", message: localizeNetworkError(error, t("ob-network-test-error-fallback")) });
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
    if (connectionModeDraft === "network") {
      if (roomId.trim()) setSharedNetworkRoomId(roomId.trim());
    } else {
      saveLlmDraft();
    }
    setConnectionMode(connectionModeDraft);
    setStep(2);
  }

  function handleLanguageNext() {
    setStep(3);
  }

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    cardRef.current?.focus();
    return () => {
      if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus();
    };
  }, []);

  // Minimal Tab/Shift+Tab focus trap: keep focus cycling within the card
  // while the wizard is mounted.
  function handleCardKeyDown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const card = cardRef.current;
    if (!card) return;
    const focusables = getFocusableElements(card);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === card) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  useShortcuts(
    SHORTCUT_PRIORITY.modal,
    (e) => {
      if (e.key === "Escape") {
        props.onClose();
        return true;
      }
      if (isEditableTarget(e.target)) return false;
      if (e.key === "ArrowRight") {
        if (step === 0) {
          setStep(1);
          return true;
        }
        if (step === 1) {
          handleLlmNext();
          return true;
        }
        if (step === 2) {
          handleLanguageNext();
          return true;
        }
        return false;
      }
      if (e.key === "ArrowLeft") {
        if (step === 1) {
          setStep(0);
          return true;
        }
        if (step === 2) {
          setStep(1);
          return true;
        }
        return false;
      }
      return false;
    },
    { modal: true },
  );

  return (
    <div class="ob-overlay">
      <div
        class="ob-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("ob-dialog-label")}
        tabIndex={-1}
        ref={cardRef}
        onKeyDown={handleCardKeyDown}
      >
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

            <div class="ob-mode-toggle" role="radiogroup" aria-label={t("ob-llm-mode-label")}>
              <button
                type="button"
                role="radio"
                aria-checked={connectionModeDraft === "api"}
                class={`ob-mode-option${connectionModeDraft === "api" ? " is-active" : ""}`}
                onClick={() => selectConnectionMode("api")}
              >
                <Plug size={16} />
                {t("ob-llm-mode-api")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={connectionModeDraft === "network"}
                class={`ob-mode-option${connectionModeDraft === "network" ? " is-active" : ""}`}
                onClick={() => selectConnectionMode("network")}
              >
                <Network size={16} />
                {t("ob-llm-mode-network")}
              </button>
            </div>

            {connectionModeDraft === "api" ? (
              <>
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
              </>
            ) : (
              <>
                <p class="ob-text">{t("ob-network-body")}</p>

                <div class="ob-field">
                  <label class="ob-label">{t("ob-network-room-id-label")}</label>
                  <input
                    class="ob-input"
                    type="text"
                    placeholder={t("ob-network-room-id-placeholder")}
                    value={roomId}
                    onInput={(e) => {
                      setRoomId(inputValue(e));
                      setNetworkTestState({ phase: "idle" });
                    }}
                  />
                </div>

                <div class="ob-test-row">
                  <button
                    class="ob-btn"
                    type="button"
                    onClick={() => void handleTestNetwork()}
                    disabled={networkTestState.phase === "busy" || !roomId.trim()}
                  >
                    {networkTestState.phase === "busy" ? <span class="spinner" /> : <Network size={16} />}
                    {networkTestState.phase === "busy" ? t("ob-llm-test-busy") : t("ob-llm-test-button")}
                  </button>
                  {networkTestState.phase === "ok" && (
                    <span class="ob-test-ok">
                      <Check size={16} />
                      {t("ob-llm-test-ok")}
                    </span>
                  )}
                </div>
                {networkTestState.phase === "error" && (
                  <p class="ob-error">{t("ob-llm-test-error", { message: networkTestState.message })}</p>
                )}
              </>
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
