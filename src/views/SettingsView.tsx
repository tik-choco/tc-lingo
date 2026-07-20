import { useEffect, useRef, useState } from "preact/hooks";
import { Network, Plus, Server, Sparkles, Volume2, X } from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { emptyLlmConfig, loadLlmConfig, saveLlmConfig, subscribeLlmConfig } from "../lib/llmConfig";
import type { LlmProviderV1, ModelPresetV1, SharedLlmConfigV1 } from "../lib/llmConfig";
import {
  addPreset,
  addProvider,
  removePreset,
  removeProvider,
  setDefaultPresetId,
  updatePreset,
  updateProvider,
} from "../lib/llmConfigOps";
import { OPENAI_TTS_VOICES, fetchVoices } from "../lib/voices";
import {
  addTargetLanguage,
  loadSettings,
  removeTargetLanguage,
  saveSettings,
  setAutoExtractCards,
  setConnectionMode,
  setDefaultReasoningEffort,
  setNetworkProviderEnabled,
  setNetworkProviderPresetIds,
  setShowReadingAids,
  setTaskPresetId,
  setTaskReasoningEffort,
  subscribeSettings,
} from "../lib/settings";
import { LLM_TASKS, setSharedNetworkRoomId } from "../lib/llmConnection";
import { localizeConsumerError } from "../lib/network";
import type { ConsumerStatus } from "../lib/network";
import { isNetworkProviderBaseUrl, NETWORK_VOICE_AUTO_MODEL } from "../lib/networkModels";
import { deriveVoiceEngine } from "../lib/voice";
import { useNetworkProviderStatus } from "../hooks/useNetworkProvider";
import { NetworkProviderStatusPanel } from "../components/NetworkStatusPanel";
import { CEFR_BANDS, computedBand, loadLevels, setLevelOverride, subscribeLevels } from "../lib/level";
import type { CefrBand, LlmTask, ReasoningEffort } from "../types";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { requestOnboarding } from "../lib/onboarding";
import { useNetworkConsumerStatusWithTimestamp } from "../hooks/useNetworkConsumerStatus";
import { useSpeech } from "../hooks/useSpeech";
import { getSyncState } from "../lib/sync/session";
import { SyncPanel } from "../components/SyncPanel";
import { t } from "../i18n";

// Mirrors level.ts's private MIN_SAMPLES — how many output samples the
// automatic level estimate needs before a CEFR band is shown (below that,
// the panel shows "still estimating" with a remaining-samples count).
const MIN_LEVEL_SAMPLES = 3;

// Short greeting used by the TTS "test playback" button, one per commonly
// supported target language (see lib/languages.ts languageOptions). A
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

// Display order + i18n keys for the タスク tab's per-LlmTask rows: a short
// (1-2 word) label plus a one-sentence hover tip (see the [data-tip] CSS in
// styles/views.css) — the fuller task descriptions used to live in
// always-visible copy; see tc-docs/drafts/llm-settings-common-v1.md §3.2's
// "説明文は最小限、詳細はラベルの hover ツールチップへ" principle.
const TASK_LABEL_KEYS: Record<LlmTask, string> = {
  practice: "settings-task-practice",
  topic: "settings-task-topic",
  cards: "settings-task-cards",
  review: "settings-task-review",
  reading: "settings-task-reading",
  conversation: "settings-task-conversation",
  grammar: "settings-task-grammar",
  "ui-translation": "settings-task-ui-translation",
};

const TASK_TIP_KEYS: Record<LlmTask, string> = {
  practice: "settings-task-tip-practice",
  topic: "settings-task-tip-topic",
  cards: "settings-task-tip-cards",
  review: "settings-task-tip-review",
  reading: "settings-task-tip-reading",
  conversation: "settings-task-tip-conversation",
  grammar: "settings-task-tip-grammar",
  "ui-translation": "settings-task-tip-ui-translation",
};

const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

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

// Fallback label for a provider row when no explicit label was given —
// just the host, so "https://api.openai.com/v1" reads as "api.openai.com".
function getHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

type SettingsTab = "general" | "connection" | "network" | "tasks" | "sync";

const TABS: Array<{ id: SettingsTab; labelKey: string }> = [
  { id: "general", labelKey: "settings-tab-general" },
  { id: "connection", labelKey: "settings-tab-connection" },
  { id: "network", labelKey: "settings-tab-network" },
  { id: "tasks", labelKey: "settings-tab-tasks" },
  { id: "sync", labelKey: "settings-tab-sync" },
];

export function SettingsView() {
  // A `#/sync/<roomId>` deep link (or a sync session already underway from
  // before a reload) should land directly on the 同期 tab instead of 全般.
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const syncState = getSyncState();
    return syncState.pendingJoinRoomId || syncState.phase !== "idle" ? "sync" : "general";
  });
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const [levelRecords, setLevelRecords] = useState(loadLevels);
  useEffect(() => subscribeLevels(() => setLevelRecords(loadLevels())), []);
  const { status, updatedAt } = useNetworkConsumerStatusWithTimestamp();
  const currentStepIndex = networkStepIndex(status.phase);
  // Display-only mirror of the single useNetworkProvider() instance mounted
  // in app.tsx — see hooks/useNetworkProvider.ts's useNetworkProviderStatus
  // doc comment for why this view must not call useNetworkProvider itself.
  const networkProviderState = useNetworkProviderStatus();

  // ----- Shared llm config (providers/presets/tts/network.roomId) ------------
  // Local mirror of the shared config, kept in sync with our own writes
  // (updateTts, the provider/preset editors, setDefaultPresetId, room id) plus
  // cross-tab writes (subscribeLlmConfig). Same-tab writes to
  // tc-shared-llm-config-v1 don't self-notify (see llmConfig.ts), so every
  // handler below that mutates it also calls setSharedConfig directly.
  const [sharedConfig, setSharedConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  useEffect(() => subscribeLlmConfig((cfg) => setSharedConfig(cfg ?? emptyLlmConfig())), []);
  const speech = useSpeech();

  // Local draft for the Room ID field: mirrors sharedConfig.network.roomId
  // until the user focuses the input, then holds their in-progress edit and
  // commits on blur.
  const [roomIdDraft, setRoomIdDraft] = useState(sharedConfig.network.roomId);
  const roomIdFocused = useRef(false);
  useEffect(() => {
    if (!roomIdFocused.current) setRoomIdDraft(sharedConfig.network.roomId);
  }, [sharedConfig.network.roomId]);

  function commitRoomId() {
    roomIdFocused.current = false;
    setSharedNetworkRoomId(roomIdDraft);
    setSharedConfig(loadLlmConfig() ?? emptyLlmConfig());
  }

  function updateTts(patch: { providerId?: string; model?: string; voice?: string }) {
    const current = loadLlmConfig() ?? emptyLlmConfig();
    const currentTts = current.tts ?? { model: "" };
    current.tts = { ...currentTts, ...patch };
    saveLlmConfig(current);
    setSharedConfig(current);
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

  // ----- 接続先/モデル (providers/presets) -----------------------------------
  // Two independent flat sections (providers, presets), each a card grid with
  // inline row editing; there is no separate "test connection" button —
  // committing a provider's baseUrl/apiKey (or opening a preset editor)
  // re-fetches that provider's model list, and success/failure of that fetch
  // doubles as the connection check. Skipped entirely for the mist-network://
  // pseudo-provider (an AI Network room mirrored in as a provider, see
  // lib/networkModels.ts) — it has no HTTP model list to fetch.

  const [modelsByProviderId, setModelsByProviderId] = useState<Record<string, string[]>>({});
  const [loadingProviderId, setLoadingProviderId] = useState("");
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});

  const [editingProviderId, setEditingProviderId] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [npLabel, setNpLabel] = useState("");
  const [npBaseUrl, setNpBaseUrl] = useState("");
  const [npApiKey, setNpApiKey] = useState("");

  const [addingModel, setAddingModel] = useState(false);
  const [amLabel, setAmLabel] = useState("");
  const [amProviderId, setAmProviderId] = useState("");
  const [amModel, setAmModel] = useState("");
  const [editingPresetId, setEditingPresetId] = useState("");
  const [epLabel, setEpLabel] = useState("");
  const [epProviderId, setEpProviderId] = useState("");
  const [epModel, setEpModel] = useState("");

  const providerFetchGenerationRef = useRef(new Map<string, number>());

  function closeAllInlineRows() {
    setEditingProviderId("");
    setAddingProvider(false);
    setEditingPresetId("");
    setAddingModel(false);
  }

  useEffect(() => {
    if (editingProviderId && !sharedConfig.providers.some((p) => p.id === editingProviderId)) {
      setEditingProviderId("");
    }
    if (editingPresetId && !sharedConfig.presets.some((p) => p.id === editingPresetId)) {
      setEditingPresetId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedConfig, editingProviderId, editingPresetId]);

  // Exactly one inline row is open at a time (provider edit/add, preset
  // edit/add), and it closes on outside click or Escape. mousedown position
  // is tracked separately from click because a text selection that starts
  // inside the row but ends (mouseup) outside it produces a click whose
  // target sits outside the row too — without this guard that drag-select
  // would be misread as an outside click and close the row mid-edit.
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const mouseDownInsideRef = useRef(false);
  useEffect(() => {
    if (!editingProviderId && !addingProvider && !editingPresetId && !addingModel) return undefined;

    function handleDocumentMouseDown(event: MouseEvent) {
      mouseDownInsideRef.current = Boolean(
        activeRowRef.current && event.target instanceof Node && activeRowRef.current.contains(event.target),
      );
    }
    function handleDocumentClick(event: MouseEvent) {
      if (activeRowRef.current && event.target instanceof Node && activeRowRef.current.contains(event.target)) return;
      if (mouseDownInsideRef.current) return;
      closeAllInlineRows();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeAllInlineRows();
    }

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [editingProviderId, addingProvider, editingPresetId, addingModel]);

  function getHostLabelForProvider(provider: LlmProviderV1): string {
    return getHostLabel(provider.baseUrl);
  }

  function getProviderLabel(providerId: string): string {
    const provider = sharedConfig.providers.find((p) => p.id === providerId);
    return provider ? provider.label || getHostLabelForProvider(provider) : "";
  }

  function isNetworkPresetProvider(providerId: string): boolean {
    const provider = sharedConfig.providers.find((p) => p.id === providerId);
    return provider ? isNetworkProviderBaseUrl(provider.baseUrl) : false;
  }

  // Badges shown on a preset card: default preset, each task currently
  // pointed at it (reusing the task's own short label as the badge text —
  // see tc-docs/drafts/llm-settings-common-v1.md §3.1), AI-Network-derived,
  // and "currently shared to the room".
  function getPresetBadges(preset: ModelPresetV1): string[] {
    const badges: string[] = [];
    if (sharedConfig.defaultPresetId === preset.id) badges.push(t("settings-badge-default"));
    for (const task of LLM_TASKS) {
      if (settings.taskPresetIds[task] === preset.id) badges.push(t(TASK_LABEL_KEYS[task]));
    }
    if (isNetworkPresetProvider(preset.providerId)) badges.push(t("settings-badge-network"));
    if (settings.networkProviderPresetIds.includes(preset.id)) badges.push(t("settings-badge-sharing"));
    return badges;
  }

  async function fetchProviderModels(provider: LlmProviderV1): Promise<string[]> {
    const generations = providerFetchGenerationRef.current;
    const myGeneration = (generations.get(provider.id) ?? 0) + 1;
    generations.set(provider.id, myGeneration);
    const isStale = () => generations.get(provider.id) !== myGeneration;

    setLoadingProviderId(provider.id);
    setProviderModelErrors((current) => ({ ...current, [provider.id]: "" }));
    let models: string[] = [];
    try {
      models = await fetchModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    } catch {
      models = [];
    }
    if (isStale()) return models;
    setModelsByProviderId((current) => ({ ...current, [provider.id]: models }));
    if (models.length === 0) {
      setProviderModelErrors((current) => ({ ...current, [provider.id]: t("settings-llm-model-fetch-failed") }));
    }
    setLoadingProviderId((current) => (current === provider.id ? "" : current));
    return models;
  }

  function ensureProviderModelsFetched(providerId: string, options: { force?: boolean } = {}) {
    if (!providerId) return;
    if (!options.force && modelsByProviderId[providerId] !== undefined) return;
    const provider = sharedConfig.providers.find((p) => p.id === providerId);
    if (provider && !isNetworkProviderBaseUrl(provider.baseUrl)) fetchProviderModels(provider);
  }

  function getModelSelectionState(providerId: string): { isLoading: boolean; models: string[]; mode: "select" | "manual" } {
    const isLoading = loadingProviderId === providerId;
    const models = modelsByProviderId[providerId] ?? [];
    return { isLoading, models, mode: isLoading || models.length > 0 ? "select" : "manual" };
  }

  // --- Provider (接続先) section handlers -------------------------------------

  function handleOpenEditProvider(provider: LlmProviderV1) {
    closeAllInlineRows();
    setEditingProviderId(provider.id);
  }

  function handleUpdateProviderField(id: string, field: "label" | "baseUrl" | "apiKey", value: string) {
    if (field === "baseUrl" && !value.trim()) return;
    const nextConfig = updateProvider(id, { [field]: value });
    setSharedConfig(nextConfig);
    if (field === "baseUrl" || field === "apiKey") {
      setModelsByProviderId((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      const provider = nextConfig.providers.find((p) => p.id === id);
      if (provider && !isNetworkProviderBaseUrl(provider.baseUrl)) fetchProviderModels(provider);
    }
  }

  function handleOpenAddProvider() {
    closeAllInlineRows();
    setAddingProvider(true);
    setNpLabel("");
    setNpBaseUrl("");
    setNpApiKey("");
  }

  function handleCancelAddProvider() {
    setAddingProvider(false);
  }

  function handleSaveNewProvider() {
    const baseUrl = npBaseUrl.trim();
    if (!baseUrl) return;
    const { config: nextConfig, providerId } = addProvider({ label: npLabel.trim() || undefined, baseUrl, apiKey: npApiKey });
    setAddingProvider(false);
    setSharedConfig(nextConfig);
    const provider = nextConfig.providers.find((p) => p.id === providerId);
    if (provider) fetchProviderModels(provider);
  }

  function handleRemoveProviderRow(provider: LlmProviderV1) {
    const linkedPresetCount = sharedConfig.presets.filter((p) => p.providerId === provider.id).length;
    const confirmed = confirm(
      linkedPresetCount > 0
        ? t("settings-llm-confirm-remove-provider-cascade", { count: linkedPresetCount })
        : t("settings-llm-confirm-remove-provider"),
    );
    if (!confirmed) return;
    const nextConfig = removeProvider(provider.id);
    setSharedConfig(nextConfig);
    setModelsByProviderId((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    setProviderModelErrors((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    if (editingProviderId === provider.id) setEditingProviderId("");
    if (amProviderId === provider.id) {
      setAddingModel(false);
      setAmProviderId("");
      setAmModel("");
    }
    if (epProviderId === provider.id && editingPresetId) {
      setEditingPresetId("");
    }
  }

  // --- Preset (モデル) section handlers ---------------------------------------

  function handleOpenAddModel() {
    closeAllInlineRows();
    setAddingModel(true);
    setAmLabel("");
    setAmProviderId("");
    setAmModel("");
  }

  function handleCancelAddModel() {
    setAddingModel(false);
  }

  function handleAmProviderChange(providerId: string) {
    setAmProviderId(providerId);
    setAmModel("");
    ensureProviderModelsFetched(providerId, { force: true });
  }

  function handleSaveAddModel(modelOverride?: string) {
    const model = (modelOverride ?? amModel).trim();
    if (!amProviderId || !model) return;
    if (!sharedConfig.providers.some((p) => p.id === amProviderId)) return;
    const { config: nextConfig } = addPreset({ label: amLabel.trim() || model, providerId: amProviderId, model });
    setAddingModel(false);
    setSharedConfig(nextConfig);
  }

  function handleAmModelSelectChange(value: string) {
    setAmModel(value);
    handleSaveAddModel(value);
  }

  function handleOpenEditPreset(preset: ModelPresetV1) {
    closeAllInlineRows();
    setEditingPresetId(preset.id);
    setEpLabel(preset.label);
    setEpProviderId(preset.providerId);
    setEpModel(preset.model);
    ensureProviderModelsFetched(preset.providerId);
  }

  function applyPresetUpdate(id: string, patch: { label?: string; providerId?: string; model?: string }) {
    setSharedConfig(updatePreset(id, patch));
  }

  function handleEpLabelBlur(preset: ModelPresetV1) {
    const label = epLabel.trim() || preset.model;
    if (label !== preset.label) applyPresetUpdate(preset.id, { label });
  }

  function handleEpProviderChange(preset: ModelPresetV1, providerId: string) {
    setEpProviderId(providerId);
    setEpModel("");
    applyPresetUpdate(preset.id, { providerId });
    ensureProviderModelsFetched(providerId, { force: true });
  }

  function handleEpModelSelectChange(preset: ModelPresetV1, value: string) {
    setEpModel(value);
    if (sharedConfig.providers.some((p) => p.id === epProviderId)) {
      applyPresetUpdate(preset.id, { model: value });
    }
    setEditingPresetId("");
  }

  function handleEpModelManualBlur(preset: ModelPresetV1) {
    const model = epModel.trim();
    if (model && model !== preset.model && sharedConfig.providers.some((p) => p.id === epProviderId)) {
      applyPresetUpdate(preset.id, { model });
    }
    setEditingPresetId("");
  }

  function handleRemovePresetRow(id: string) {
    if (!confirm(t("settings-llm-confirm-remove-model"))) return;
    const nextConfig = removePreset(id);
    setSharedConfig(nextConfig);
    if (editingPresetId === id) setEditingPresetId("");
  }

  function renderProviderRow(provider: LlmProviderV1) {
    const isEditing = editingProviderId === provider.id;
    const isNetwork = isNetworkProviderBaseUrl(provider.baseUrl);
    const hostLabel = getHostLabelForProvider(provider);

    if (isEditing) {
      return (
        <div class="llm-row llm-row-editing" key={provider.id} ref={activeRowRef}>
          <div class="llm-edit-fields">
            <input
              type="text"
              value={provider.label}
              onBlur={(e) => handleUpdateProviderField(provider.id, "label", (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder={t("settings-llm-provider-label-placeholder")}
              autoComplete="off"
            />
            <input
              type="text"
              value={provider.baseUrl}
              title={provider.baseUrl}
              onBlur={(e) => handleUpdateProviderField(provider.id, "baseUrl", (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder={t("settings-llm-provider-baseurl-placeholder")}
              autoComplete="off"
            />
            <input
              type="password"
              value={provider.apiKey}
              onBlur={(e) => handleUpdateProviderField(provider.id, "apiKey", (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder={t("settings-llm-provider-apikey-placeholder")}
              autoComplete="off"
            />
            {providerModelErrors[provider.id] ? (
              <p class="hint-text llm-form-warning">{providerModelErrors[provider.id]}</p>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div class={`llm-row${isNetwork ? " llm-row-network" : ""}`} key={provider.id}>
        <button
          type="button"
          class="llm-row-main"
          title={t("settings-llm-edit-title")}
          onClick={() => handleOpenEditProvider(provider)}
        >
          <span class="llm-row-label">{provider.label || hostLabel}</span>
          <span class="llm-row-model">{isNetwork ? t("settings-llm-network-provider-note") : hostLabel}</span>
        </button>
        <div class="llm-row-icons">
          <button
            type="button"
            class="llm-icon-button llm-row-remove"
            title={t("settings-llm-remove-provider-title")}
            onClick={(e) => {
              e.stopPropagation();
              handleRemoveProviderRow(provider);
            }}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  function renderAddProviderRow() {
    return (
      <div class="llm-row llm-row-editing llm-row-add" ref={activeRowRef}>
        <div class="llm-edit-fields">
          <input
            type="text"
            value={npLabel}
            onInput={(e) => setNpLabel((e.target as HTMLInputElement).value)}
            placeholder={t("settings-llm-provider-label-placeholder")}
            autoComplete="off"
          />
          <input
            type="text"
            value={npBaseUrl}
            onInput={(e) => setNpBaseUrl((e.target as HTMLInputElement).value)}
            placeholder={t("settings-llm-provider-baseurl-placeholder")}
            autoComplete="off"
          />
          <input
            type="password"
            value={npApiKey}
            onInput={(e) => setNpApiKey((e.target as HTMLInputElement).value)}
            placeholder={t("settings-llm-provider-apikey-placeholder")}
            autoComplete="off"
          />
        </div>
        <div class="llm-add-actions">
          <button
            type="button"
            class="llm-form-btn llm-form-btn-primary"
            onClick={handleSaveNewProvider}
            disabled={!npBaseUrl.trim()}
          >
            <Plus size={13} />
            {t("settings-llm-add-button")}
          </button>
          <button type="button" class="llm-form-btn" onClick={handleCancelAddProvider}>
            {t("settings-llm-cancel-button")}
          </button>
        </div>
      </div>
    );
  }

  function renderAddProviderTile() {
    if (addingProvider) return renderAddProviderRow();
    return (
      <button type="button" class="llm-add-tile" onClick={handleOpenAddProvider}>
        <Plus size={16} />
        <span>{t("settings-llm-add-provider")}</span>
      </button>
    );
  }

  function renderModelRow(preset: ModelPresetV1) {
    const isEditing = editingPresetId === preset.id;

    if (isEditing) {
      const { mode: epMode, isLoading: epLoading, models: providerModels } = getModelSelectionState(epProviderId);
      const modelError = epProviderId ? providerModelErrors[epProviderId] : "";
      return (
        <div class="llm-row llm-row-editing" key={preset.id} ref={activeRowRef}>
          <div class="llm-edit-fields">
            <input
              type="text"
              value={epLabel}
              onInput={(e) => setEpLabel((e.target as HTMLInputElement).value)}
              onBlur={() => handleEpLabelBlur(preset)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder={t("settings-llm-model-label-placeholder")}
              autoComplete="off"
            />
            <select
              value={epProviderId}
              onChange={(e) => handleEpProviderChange(preset, (e.target as HTMLSelectElement).value)}
            >
              {sharedConfig.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label || getHostLabelForProvider(provider)}
                </option>
              ))}
            </select>
            <div class="llm-model-field">
              {epMode === "select" ? (
                <select
                  value={epModel}
                  onChange={(e) => handleEpModelSelectChange(preset, (e.target as HTMLSelectElement).value)}
                >
                  <option value="" disabled>
                    {epLoading ? t("settings-llm-model-loading") : t("settings-llm-model-select-placeholder")}
                  </option>
                  {epModel && !providerModels.includes(epModel) ? <option value={epModel}>{epModel}</option> : null}
                  {providerModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={epModel}
                  onInput={(e) => setEpModel((e.target as HTMLInputElement).value)}
                  onBlur={() => handleEpModelManualBlur(preset)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  placeholder={t("settings-llm-model-manual-placeholder")}
                  autoComplete="off"
                />
              )}
            </div>
            {modelError ? <p class="hint-text llm-form-warning">{modelError}</p> : null}
          </div>
        </div>
      );
    }

    const badges = getPresetBadges(preset);
    const isNetwork = isNetworkPresetProvider(preset.providerId);
    return (
      <div class={`llm-row${isNetwork ? " llm-row-network" : ""}`} key={preset.id}>
        <button
          type="button"
          class="llm-row-main"
          title={t("settings-llm-edit-title")}
          onClick={() => handleOpenEditPreset(preset)}
        >
          <span class="llm-row-label">{preset.label}</span>
          <span class="llm-row-model">{preset.model}</span>
          <span class="llm-row-provider">{getProviderLabel(preset.providerId)}</span>
        </button>
        {badges.length > 0 ? (
          <span class="llm-row-badges">
            {badges.map((badge) => (
              <span key={badge} class="llm-row-badge">
                {badge}
              </span>
            ))}
          </span>
        ) : null}
        <div class="llm-row-icons">
          <button
            type="button"
            class="llm-icon-button llm-row-remove"
            title={t("settings-llm-remove-model-title")}
            onClick={(e) => {
              e.stopPropagation();
              handleRemovePresetRow(preset.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  function renderAddModelRow() {
    const { mode: amMode, isLoading: amLoading, models: providerModels } = getModelSelectionState(amProviderId);
    const modelError = amProviderId ? providerModelErrors[amProviderId] : "";
    return (
      <div class="llm-row llm-row-editing llm-row-add" ref={activeRowRef}>
        <div class="llm-edit-fields">
          <input
            type="text"
            value={amLabel}
            onInput={(e) => setAmLabel((e.target as HTMLInputElement).value)}
            placeholder={t("settings-llm-model-label-placeholder")}
            autoComplete="off"
          />
          <select value={amProviderId} onChange={(e) => handleAmProviderChange((e.target as HTMLSelectElement).value)}>
            <option value="" disabled>
              {t("settings-llm-provider-select-placeholder")}
            </option>
            {sharedConfig.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label || getHostLabelForProvider(provider)}
              </option>
            ))}
          </select>
          <div class="llm-model-field">
            {!amProviderId ? (
              <select value="" disabled>
                <option value="">{t("settings-llm-provider-select-first")}</option>
              </select>
            ) : amMode === "select" ? (
              <select value={amModel} onChange={(e) => handleAmModelSelectChange((e.target as HTMLSelectElement).value)}>
                <option value="" disabled>
                  {amLoading ? t("settings-llm-model-loading") : t("settings-llm-model-select-placeholder")}
                </option>
                {providerModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={amModel}
                onInput={(e) => setAmModel((e.target as HTMLInputElement).value)}
                onBlur={() => handleSaveAddModel()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                placeholder={t("settings-llm-model-manual-placeholder")}
                autoComplete="off"
              />
            )}
          </div>
          {modelError ? <p class="hint-text llm-form-warning">{modelError}</p> : null}
        </div>
        <div class="llm-add-actions">
          <button type="button" class="llm-form-btn" onClick={handleCancelAddModel}>
            {t("settings-llm-cancel-button")}
          </button>
        </div>
      </div>
    );
  }

  function renderAddModelTile() {
    if (sharedConfig.providers.length === 0) {
      return (
        <button type="button" class="llm-add-tile" disabled title={t("settings-llm-add-model-need-provider-title")}>
          <Plus size={16} />
          <span>{t("settings-llm-add-model")}</span>
        </button>
      );
    }
    if (addingModel) return renderAddModelRow();
    return (
      <button type="button" class="llm-add-tile" onClick={handleOpenAddModel}>
        <Plus size={16} />
        <span>{t("settings-llm-add-model")}</span>
      </button>
    );
  }

  // ----- AI Network tab -------------------------------------------------------

  // Presets shareable to the AI Network room: must resolve to a real HTTP
  // provider — a preset whose provider is itself the mist-network:// pseudo-
  // provider (i.e. imported from the room) can't be re-shared (see
  // hooks/useNetworkProvider.ts's resolveSharedTargets).
  const eligiblePresets = sharedConfig.presets.filter((preset) => {
    const provider = sharedConfig.providers.find((p) => p.id === preset.providerId);
    return provider !== undefined && !isNetworkProviderBaseUrl(provider.baseUrl);
  });

  function handleToggleShareModel(presetId: string, checked: boolean) {
    const current = settings.networkProviderPresetIds;
    const next = checked ? [...current, presetId] : current.filter((id) => id !== presetId);
    setNetworkProviderPresetIds(next);
  }

  // ----- タスク tab: TTS row ---------------------------------------------------

  const ttsSettings = sharedConfig.tts ?? { model: "" };
  const ttsEngine = deriveVoiceEngine(sharedConfig, "tts");
  const matchedTtsPreset = sharedConfig.presets.find(
    (preset) => preset.providerId === ttsSettings.providerId && preset.model === ttsSettings.model,
  );
  // The room's mist-network:// pseudo-provider id, "" when none imported yet —
  // drives the "AI Networkにおまかせ" option below.
  const networkVoiceProviderId = sharedConfig.providers.find((p) => isNetworkProviderBaseUrl(p.baseUrl))?.id ?? "";
  const isTtsNetworkAuto =
    networkVoiceProviderId !== "" &&
    ttsSettings.providerId === networkVoiceProviderId &&
    ttsSettings.model === NETWORK_VOICE_AUTO_MODEL;

  const ttsProviderId = ttsSettings.providerId || sharedConfig.presets.find((p) => p.id === sharedConfig.defaultPresetId)?.providerId;
  const ttsProvider = sharedConfig.providers.find((p) => p.id === ttsProviderId);

  // Voice names offered in the TTS voice picker, fetched only when the
  // derived engine is 'api' (network/browser have no HTTP voice list to
  // fetch). Failures fall back to the documented OpenAI voice set; a voice
  // saved from another server stays selectable via an extra <option> below.
  const [ttsVoiceOptions, setTtsVoiceOptions] = useState<string[] | null>(null);
  useEffect(() => {
    if (ttsEngine !== "api" || !ttsProvider?.baseUrl) {
      setTtsVoiceOptions(null);
      return;
    }
    let cancelled = false;
    fetchVoices({ baseUrl: ttsProvider.baseUrl, apiKey: ttsProvider.apiKey })
      .then((voices) => {
        if (!cancelled) setTtsVoiceOptions(voices);
      })
      .catch(() => {
        if (!cancelled) setTtsVoiceOptions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ttsEngine, ttsProvider?.baseUrl, ttsProvider?.apiKey]);
  const voiceOptions = ttsVoiceOptions ?? OPENAI_TTS_VOICES;

  return (
    <div class="view-container settings-view">
      <div class="settings-tab-bar" role="tablist" aria-label={t("settings-tabs-aria-label")}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            class={`settings-tab${activeTab === tab.id ? " active" : ""}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
        <div class="settings-tab-panel" role="tabpanel">
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
            <h2>{t("settings-automation-heading")}</h2>

            <div class="field-grid">
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.autoExtractCards}
                  onChange={(e) => setAutoExtractCards((e.target as HTMLInputElement).checked)}
                />
                {t("settings-auto-extract-label")}
              </label>
              <p class="hint-text">{t("settings-auto-extract-hint")}</p>
            </div>

            <div class="field-grid">
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.showReadingAids}
                  onChange={(e) => setShowReadingAids((e.target as HTMLInputElement).checked)}
                />
                {t("settings-reading-aids-label")}
              </label>
              <p class="hint-text">{t("settings-reading-aids-hint")}</p>
            </div>

            <div class="field-grid">
              <h3 class="settings-subheading">{t("settings-level-heading")}</h3>
              <p class="hint-text">{t("settings-level-hint")}</p>
              <div class="level-panel">
                {settings.targetLanguages.map((lang) => {
                  const record = levelRecords.find((r) => r.language === lang) ?? null;
                  const band = computedBand(record);
                  const remaining = Math.max(0, MIN_LEVEL_SAMPLES - (record?.samples ?? 0));
                  return (
                    <div class="level-row" key={lang}>
                      <span class="level-row-language">{languageDisplayName(lang)}</span>
                      <span class="level-row-estimate">
                        {band ? (
                          <>
                            <span class="level-row-band">{band}</span>
                            <span>{t("settings-level-samples", { count: record?.samples ?? 0 })}</span>
                          </>
                        ) : (
                          <span>{t("settings-level-estimating", { count: remaining })}</span>
                        )}
                      </span>
                      <select
                        class="level-row-select"
                        value={record?.override ?? ""}
                        onChange={(e) => setLevelOverride(lang, (e.target as HTMLSelectElement).value as CefrBand | "")}
                        aria-label={t("settings-level-override-aria-label", { language: languageDisplayName(lang) })}
                      >
                        <option value="">{t("settings-level-override-auto")}</option>
                        {CEFR_BANDS.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      )}

      {activeTab === "connection" && (
        <div class="settings-tab-panel" role="tabpanel">
          <section class="card-panel">
            <p class="hint-text">{t("settings-llm-hint")}</p>

            <h3 class="settings-subheading">{t("settings-llm-providers-heading")}</h3>
            <div class="llm-flat-section llm-flat-section-providers">
              {sharedConfig.providers.length === 0 && !addingProvider ? (
                <p class="hint-text">{t("settings-llm-providers-empty")}</p>
              ) : null}
              <div class="llm-row-list">
                {sharedConfig.providers.map((provider) => renderProviderRow(provider))}
                {renderAddProviderTile()}
              </div>
            </div>

            <h3 class="settings-subheading">{t("settings-llm-models-heading")}</h3>
            <div class="llm-flat-section llm-flat-section-models">
              {sharedConfig.providers.length === 0 ? <p class="hint-text">{t("settings-llm-models-need-provider")}</p> : null}
              {sharedConfig.providers.length > 0 && sharedConfig.presets.length === 0 && !addingModel ? (
                <p class="hint-text">{t("settings-llm-models-empty")}</p>
              ) : null}
              <div class="llm-row-list">
                {sharedConfig.presets.map((preset) => renderModelRow(preset))}
                {renderAddModelTile()}
              </div>
            </div>
          </section>
        </div>
      )}

      {activeTab === "network" && (
        <div class="settings-tab-panel" role="tabpanel">
          <section class="card-panel">
            <div class="field-grid">
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
            </div>

            <div class="field-grid">
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.connectionMode === "network"}
                  onChange={(e) => setConnectionMode((e.target as HTMLInputElement).checked ? "network" : "api")}
                />
                <Network size={15} />
                {t("settings-network-use-toggle")}
              </label>
              <p class="hint-text">{t("settings-network-use-hint")}</p>
              {settings.connectionMode === "network" ? (
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
                    <p class="error-text">{localizeConsumerError(status, t("settings-network-status-error-fallback"))}</p>
                  ) : null}
                  {updatedAt > 0 ? (
                    <p class="hint-text network-status-timestamp">
                      {t("settings-network-status-updated", { time: new Date(updatedAt).toLocaleTimeString() })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div class="field-grid">
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.networkProviderEnabled}
                  onChange={(e) => setNetworkProviderEnabled((e.target as HTMLInputElement).checked)}
                />
                <Server size={15} />
                {t("settings-network-provide-toggle")}
              </label>
              <p class="hint-text">{t("settings-network-provide-hint")}</p>
              {settings.networkProviderEnabled ? (
                <>
                  <div class="network-share-models">
                    <label>{t("settings-network-share-models-heading")}</label>
                    {eligiblePresets.length === 0 ? (
                      <p class="hint-text">{t("settings-network-share-models-empty")}</p>
                    ) : (
                      <div class="network-share-list">
                        {eligiblePresets.map((preset) => (
                          <label class="network-share-item" key={preset.id}>
                            <input
                              type="checkbox"
                              checked={settings.networkProviderPresetIds.includes(preset.id)}
                              onChange={(e) => handleToggleShareModel(preset.id, (e.target as HTMLInputElement).checked)}
                            />
                            <span class="network-share-item-label">{preset.label || preset.model}</span>
                            <span class="network-share-item-model">
                              {preset.model} · {getProviderLabel(preset.providerId)}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  <NetworkProviderStatusPanel
                    providerStatus={networkProviderState.status}
                    providerStatusUpdatedAt={networkProviderState.statusUpdatedAt}
                    providerError={networkProviderState.errorMessage}
                    ownNodeId={networkProviderState.ownNodeId}
                    peers={networkProviderState.peers}
                    consumerCount={networkProviderState.consumerCount}
                    logs={networkProviderState.logs}
                    upstreamConfigured={networkProviderState.upstreamConfigured}
                  />
                </>
              ) : null}
            </div>
          </section>
        </div>
      )}

      {activeTab === "tasks" && (
        <div class="settings-tab-panel" role="tabpanel">
          <section class="card-panel">
            <div class="task-model-item">
              <span data-tip={t("settings-task-tip-default")}>{t("settings-task-default-label")}</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={sharedConfig.defaultPresetId}
                    onChange={(e) => setSharedConfig(setDefaultPresetId((e.target as HTMLSelectElement).value))}
                    aria-label={t("settings-task-default-label")}
                  >
                    <option value="">{t("settings-preset-unset-option")}</option>
                    {sharedConfig.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label || preset.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="task-model-field">
                  <select
                    value={settings.defaultReasoningEffort}
                    onChange={(e) => setDefaultReasoningEffort((e.target as HTMLSelectElement).value as ReasoningEffort)}
                    aria-label={t("settings-reasoning-effort-label")}
                    title={t("settings-reasoning-effort-label")}
                  >
                    {REASONING_EFFORT_OPTIONS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {LLM_TASKS.map((task) => (
              <div class="task-model-item" key={task}>
                <span data-tip={t(TASK_TIP_KEYS[task])}>{t(TASK_LABEL_KEYS[task])}</span>
                <div class="task-model-fields">
                  <div class="task-model-field">
                    <select
                      value={settings.taskPresetIds[task] ?? ""}
                      onChange={(e) => setTaskPresetId(task, (e.target as HTMLSelectElement).value)}
                      aria-label={t(TASK_LABEL_KEYS[task])}
                    >
                      <option value="">{t("settings-task-follow-default-option")}</option>
                      {sharedConfig.presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label || preset.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div class="task-model-field">
                    <select
                      value={settings.taskReasoningEfforts[task] ?? settings.defaultReasoningEffort}
                      onChange={(e) => setTaskReasoningEffort(task, (e.target as HTMLSelectElement).value as ReasoningEffort)}
                      aria-label={t("settings-reasoning-effort-label")}
                      title={t("settings-reasoning-effort-label")}
                    >
                      {REASONING_EFFORT_OPTIONS.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}

            <div class="task-model-item">
              <span data-tip={t("settings-task-tip-tts")}>{t("settings-task-tts-label")}</span>
              <div class="task-model-fields">
                <div class="task-model-field">
                  <select
                    value={
                      isTtsNetworkAuto
                        ? "__network__"
                        : matchedTtsPreset
                          ? matchedTtsPreset.id
                          : ttsSettings.model.trim() && ttsSettings.model !== NETWORK_VOICE_AUTO_MODEL
                            ? "__current__"
                            : ""
                    }
                    onChange={(e) => {
                      const value = (e.target as HTMLSelectElement).value;
                      if (value === "__current__") return;
                      if (value === "") {
                        updateTts({ providerId: undefined, model: "" });
                        return;
                      }
                      if (value === "__network__") {
                        updateTts({ providerId: networkVoiceProviderId, model: NETWORK_VOICE_AUTO_MODEL });
                        return;
                      }
                      const preset = sharedConfig.presets.find((p) => p.id === value);
                      if (!preset) return;
                      updateTts({ providerId: preset.providerId, model: preset.model });
                    }}
                    aria-label={t("settings-task-tts-label")}
                  >
                    <option value="">{t("settings-voice-model-browser-option")}</option>
                    {networkVoiceProviderId ? (
                      <option value="__network__">{t("settings-voice-model-network-auto-option")}</option>
                    ) : null}
                    {ttsSettings.model.trim() && !matchedTtsPreset && !isTtsNetworkAuto ? (
                      <option value="__current__">{ttsSettings.model}</option>
                    ) : null}
                    {sharedConfig.presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label || preset.model || preset.id}
                      </option>
                    ))}
                  </select>
                </div>
                {ttsEngine !== "browser" && ttsSettings.model !== NETWORK_VOICE_AUTO_MODEL ? (
                  <div class="task-model-field">
                    <select
                      value={ttsSettings.voice ?? ""}
                      onChange={(e) => updateTts({ voice: (e.target as HTMLSelectElement).value })}
                      aria-label={t("settings-voice-voice-label")}
                    >
                      <option value="">{t("settings-tts-voice-default")}</option>
                      {ttsSettings.voice && !voiceOptions.includes(ttsSettings.voice) ? (
                        <option value={ttsSettings.voice}>{ttsSettings.voice}</option>
                      ) : null}
                      {voiceOptions.map((voice) => (
                        <option key={voice} value={voice}>
                          {voice}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            </div>
            {ttsEngine === "api" && !ttsProvider?.baseUrl ? <p class="error-text">{t("settings-voice-connection-unresolved")}</p> : null}

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
      )}

      {activeTab === "sync" && (
        <div class="settings-tab-panel" role="tabpanel">
          <SyncPanel />
        </div>
      )}
    </div>
  );
}
