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
      <div class="ob-card" role="dialog" aria-modal="true" aria-label="はじめてのセットアップ">
        <button class="ob-close" type="button" onClick={props.onClose} title="閉じる" aria-label="閉じる">
          <X size={18} />
        </button>

        {step === 0 && (
          <div class="ob-body">
            <div class="ob-hero">
              <Sparkles size={36} />
            </div>
            <h2 class="ob-title">TC Lingo へようこそ！</h2>
            <p class="ob-text">
              TC Lingo は、選択式のドリルではなく「自分の言葉で書く → AIに添削してもらう → もう一度挑戦する」ことに絞った語学学習アプリです。
            </p>
            <p class="ob-text">
              まずは2つだけ準備しましょう：<strong>LLMの接続設定</strong>と<strong>学習する言語</strong>です。
              どちらもあとから設定画面でいつでも変更できます。
            </p>
          </div>
        )}

        {step === 1 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Cpu size={22} />
              <h2 class="ob-title">LLMの接続設定</h2>
            </div>
            <p class="ob-text">
              添削やトピック生成に使うLLMを設定します。OpenAI互換のAPIならどれでも使えます(OpenAI、LM
              Studio、Ollamaなど)。tik-chocoの他アプリと共有される設定なので、一度設定すれば十分です。
            </p>

            <div class="ob-field">
              <label class="ob-label">ベースURL</label>
              <input
                class="ob-input"
                type="text"
                placeholder="例: https://api.openai.com/v1"
                value={llm.baseUrl}
                onInput={(e) => updateLlm({ baseUrl: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">APIキー(不要なら空欄)</label>
              <input
                class="ob-input"
                type="password"
                placeholder="sk-..."
                value={llm.apiKey}
                onInput={(e) => updateLlm({ apiKey: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">モデル</label>
              <div class="ob-model-row">
                <input
                  class="ob-input"
                  type="text"
                  list="ob-model-options"
                  placeholder="例: gpt-4.1-mini"
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
                  title="モデル一覧を取得"
                >
                  {fetchingModels ? "…" : "取得"}
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
                {testState.phase === "busy" ? "接続中…" : "接続テスト"}
              </button>
              {testState.phase === "ok" && (
                <span class="ob-test-ok">
                  <Check size={16} />
                  接続できました！
                </span>
              )}
            </div>
            {testState.phase === "error" && <p class="ob-error">接続に失敗しました: {testState.message}</p>}
          </div>
        )}

        {step === 2 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Languages size={22} />
              <h2 class="ob-title">学習する言語を選ぶ</h2>
            </div>
            <p class="ob-text">学習中の言語と、添削の説明に使う母語を設定します。あとから設定画面でいつでも変更できます。</p>
            <div class="ob-field">
              <label class="ob-label">学習中の言語</label>
              <div class="language-chip-list">
                {langSettings.targetLanguages.map((lang) => (
                  <span class="language-chip" key={lang}>
                    {languageDisplayName(lang)}
                    <button
                      type="button"
                      disabled={langSettings.targetLanguages.length <= 1}
                      title="削除"
                      aria-label={`${languageDisplayName(lang)}を削除`}
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
                placeholder="言語を追加"
                ariaLabel="学習言語を追加"
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">母語(説明に使う言語)</label>
              <LanguageSelect
                value={langSettings.nativeLanguage}
                onChange={(lang) => {
                  const next = { ...loadSettings(), nativeLanguage: lang };
                  saveSettings(next);
                  setLangSettings(next);
                }}
                ariaLabel="母語を選択"
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Check size={22} />
              <h2 class="ob-title">準備完了です！</h2>
            </div>
            <ul class="ob-feature-list">
              <li>
                <PenLine size={16} />
                <span>
                  <strong>練習</strong> — トピックに自由記述で答え、AIが原文/修正版/理由/再回答問題を返します
                </span>
              </li>
              <li>
                <Repeat2 size={16} />
                <span>
                  <strong>復習</strong> — 選択肢のない検索練習で、登録したカードを復習します
                </span>
              </li>
              <li>
                <Layers size={16} />
                <span>
                  <strong>カード</strong> — 間違いから自動で作られたカードや、自分で追加したカードを管理します
                </span>
              </li>
              <li>
                <History size={16} />
                <span>
                  <strong>履歴</strong> — 同じトピックを最大3回記録し、ラウンド間の変化を確認できます
                </span>
              </li>
            </ul>
            <p class="ob-text ob-text-subtle">編集はすべて自動保存されます。それでは、始めましょう！</p>
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
                戻る
              </button>
            )}
            {step === 0 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(1)}>
                はじめる
                <ArrowRight size={16} />
              </button>
            )}
            {step === 1 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLlmNext}>
                保存して次へ
                <ArrowRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLanguageNext}>
                保存して次へ
                <ArrowRight size={16} />
              </button>
            )}
            {step === 3 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={props.onClose}>
                <Check size={16} />
                完了
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
