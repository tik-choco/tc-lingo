import { useEffect, useRef, useState } from "preact/hooks";
import { Network, Pencil, Plus, Server, Sparkles, Volume2, X } from "lucide-preact";
import { fetchModels } from "@tik-choco/mistai";
import { emptyLlmConfig, loadLlmConfig, resolvePreset, saveLlmConfig, subscribeLlmConfig } from "../lib/llmConfig";
import type { LlmProviderV1, ModelPresetV1, SharedLlmConfigV1, VoiceConfigV1 } from "../lib/llmConfig";
import {
  addPreset,
  addProvider,
  removePreset,
  removeProvider,
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
  setShowReadingAids,
  setTtsEngine,
  subscribeSettings,
} from "../lib/settings";
import { setSharedNetworkRoomId } from "../lib/llmConnection";
import { localizeConsumerError } from "../lib/network";
import type { ConsumerStatus } from "../lib/network";
import { CEFR_BANDS, computedBand, loadLevels, setLevelOverride, subscribeLevels } from "../lib/level";
import type { CefrBand } from "../types";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { requestOnboarding } from "../lib/onboarding";
import { useLlmConnection } from "../hooks/useLlmConnection";
import { useNetworkConsumerStatusWithTimestamp } from "../hooks/useNetworkConsumerStatus";
import { useSpeech } from "../hooks/useSpeech";
import { t } from "../i18n";

// Mirrors level.ts's private MIN_SAMPLES — how many output samples the
// automatic level estimate needs before a CEFR band is shown (below that,
// the panel shows "still estimating" with a remaining-samples count).
const MIN_LEVEL_SAMPLES = 3;

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

// Fallback label for a provider row when no explicit label was given —
// just the host, so "https://api.openai.com/v1" reads as "api.openai.com".
function getHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

export function SettingsView() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const [levelRecords, setLevelRecords] = useState(loadLevels);
  useEffect(() => subscribeLevels(() => setLevelRecords(loadLevels())), []);
  const { mode, roomId } = useLlmConnection();
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

  // ----- TTS (音声読み上げ) + LLM接続 (共有設定) --------------------------------
  // Local mirror of the shared llm config, kept in sync with our own writes
  // (updateTts, and the provider/preset editors further below) plus cross-tab
  // writes (subscribeLlmConfig). Same-tab writes to tc-shared-llm-config-v1
  // don't self-notify (see llmConfig.ts), so `target`/`config` from
  // useLlmConnection can't be reused here without adding a dependency on that
  // hook's refresh path — this is the single config source for both the TTS
  // section and the LLM connection section below.
  const [sharedConfig, setSharedConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());
  useEffect(() => subscribeLlmConfig((cfg) => setSharedConfig(cfg ?? emptyLlmConfig())), []);
  // Fetched option lists for the TTS model/voice selects. null = fetch failed
  // or not applicable (browser/network engine, no provider) → the field falls
  // back to a manual text input, mirroring the LLM section's select/manual
  // dichotomy.
  const [ttsVoiceOptions, setTtsVoiceOptions] = useState<string[] | null>(null);
  const [ttsModelOptions, setTtsModelOptions] = useState<string[] | null>(null);
  const [ttsOptionsLoading, setTtsOptionsLoading] = useState(false);
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
  // the auto-fetch below targets the right endpoint.
  const ttsProviderId =
    sharedConfig.tts?.providerId || sharedConfig.presets.find((p) => p.id === sharedConfig.defaultPresetId)?.providerId;
  const ttsProvider = sharedConfig.providers.find((p) => p.id === ttsProviderId);

  // Auto-fetch the model/voice lists whenever the effective TTS provider
  // changes (no manual fetch button — same "fetching doubles as the
  // connection check" stance as the LLM section). Voices come from
  // /audio/voices→/voices (lib/voices.ts), models from /models; the model
  // list is narrowed to speech-looking ids when any exist, since /models
  // returns the provider's full catalog including chat models.
  useEffect(() => {
    if (settings.ttsEngine !== "api" || !ttsProvider?.baseUrl) {
      setTtsVoiceOptions(null);
      setTtsModelOptions(null);
      setTtsOptionsLoading(false);
      return;
    }
    let cancelled = false;
    setTtsOptionsLoading(true);
    const connection = { baseUrl: ttsProvider.baseUrl, apiKey: ttsProvider.apiKey };
    Promise.all([
      fetchVoices(connection).catch(() => [] as string[]),
      fetchModels(connection).catch(() => [] as string[]),
    ]).then(([voices, models]) => {
      if (cancelled) return;
      setTtsVoiceOptions(voices.length > 0 ? voices : null);
      const speechModels = models.filter((id) => /tts|speech|audio/i.test(id));
      const usableModels = speechModels.length > 0 ? speechModels : models;
      setTtsModelOptions(usableModels.length > 0 ? usableModels : null);
      setTtsOptionsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.ttsEngine, ttsProvider?.baseUrl, ttsProvider?.apiKey]);

  function handleTestSpeak() {
    const sample = TTS_SAMPLE_TEXT[settings.activeLanguage] ?? TTS_SAMPLE_TEXT.English;
    speech.speak(sample, settings.activeLanguage, TTS_TEST_ID);
  }

  function updateLanguage(patch: Partial<typeof settings>) {
    const next = { ...loadSettings(), ...patch };
    setSettings(next);
    saveSettings(next);
  }

  // The "current connection" status line below needs to reflect same-tab
  // writes made by the provider/preset editors further down (addProvider,
  // updatePreset, ...), which don't self-notify subscribeLlmConfig — so it's
  // computed from `sharedConfig` (our locally-updated mirror) rather than
  // `target` from useLlmConnection, which only refreshes on cross-tab storage
  // events. mode/roomId still come from the hook.
  const target = resolvePreset(sharedConfig, settings.presetId);

  // ----- 接続先/モデル (providers/presets) -----------------------------------
  // Ported from tc-pdf-viewer's SettingsPanel: two independent flat sections
  // (providers, presets) instead of the old single add-connection form. Each
  // is a card grid with inline row editing; there is no separate "test
  // connection" button — committing a provider's baseUrl/apiKey (or opening a
  // preset editor) re-fetches that provider's model list, and success/failure
  // of that fetch doubles as the connection check.

  // providerId -> models[] cache for the model <select>s. Invalidated (and
  // re-fetched) whenever a provider's baseUrl/apiKey is committed or a
  // provider is (re)selected in an editor.
  const [modelsByProviderId, setModelsByProviderId] = useState<Record<string, string[]>>({});
  const [loadingProviderId, setLoadingProviderId] = useState("");
  // providerId -> error message, set when a model fetch throws or returns 0
  // models (0 is treated as failure since we can't otherwise distinguish
  // "empty" from "broken" here).
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});

  // Provider section: inline edit / inline add. Only one row across both
  // sections is open at a time (see closeAllInlineRows).
  const [editingProviderId, setEditingProviderId] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [npLabel, setNpLabel] = useState("");
  const [npBaseUrl, setNpBaseUrl] = useState("");
  const [npApiKey, setNpApiKey] = useState("");

  // Preset (model) section: inline edit / inline add.
  const [addingModel, setAddingModel] = useState(false);
  const [amLabel, setAmLabel] = useState("");
  const [amProviderId, setAmProviderId] = useState("");
  const [amModel, setAmModel] = useState("");
  const [editingPresetId, setEditingPresetId] = useState("");
  const [epLabel, setEpLabel] = useState("");
  const [epProviderId, setEpProviderId] = useState("");
  const [epModel, setEpModel] = useState("");

  // providerId -> generation counter for the most recent fetchProviderModels
  // call. If a provider's baseUrl/apiKey changes (or a different provider is
  // selected) while a fetch is in flight, a stale response must not clobber
  // a newer one. A ref (not state) since bumping it shouldn't re-render.
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

  // Fetches a provider's model list and caches it. Doubles as the connection
  // check: a thrown error or an empty result both record
  // settings-llm-model-fetch-failed for that provider.
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

  // force=true always re-fetches (a provider was just switched to, so a
  // cached list from a different provider can't be trusted); force=false
  // only fetches if nothing is cached yet.
  function ensureProviderModelsFetched(providerId: string, options: { force?: boolean } = {}) {
    if (!providerId) return;
    if (!options.force && modelsByProviderId[providerId] !== undefined) return;
    const provider = sharedConfig.providers.find((p) => p.id === providerId);
    if (provider) fetchProviderModels(provider);
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

  // No explicit commit button: label/baseUrl/apiKey commit on blur and the
  // row stays open (closing is left to outside click / Escape) so a user can
  // fix just the label and move on without losing their place.
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
      if (provider) fetchProviderModels(provider);
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
    // Immediately fetch models for the new provider — this both primes the
    // model add-row and acts as the connection test.
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
    // If the model add/edit drafts still pointed at this now-deleted
    // provider, close them too — leaving them open would let a save attempt
    // reference a provider that no longer exists.
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

  // "select = commit": there's no explicit add button for the model field —
  // choosing from the <select> (or blurring the manual <input> with a value)
  // saves immediately and closes the row, and makes the new preset active
  // (mirrors the old single-form "add and use" behavior).
  function handleSaveAddModel(modelOverride?: string) {
    const model = (modelOverride ?? amModel).trim();
    if (!amProviderId || !model) return;
    // Defensive: if the drafted provider vanished (e.g. removed in another
    // tab) while this row was open, don't create an orphaned preset.
    if (!sharedConfig.providers.some((p) => p.id === amProviderId)) return;
    const { config: nextConfig, presetId } = addPreset({ label: amLabel.trim() || model, providerId: amProviderId, model });
    setAddingModel(false);
    setSharedConfig(nextConfig);
    updateLanguage({ presetId });
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

  // Label doesn't close the row on blur — it's expected to be adjusted
  // alongside the provider/model fields before the row is dismissed.
  function handleEpLabelBlur(preset: ModelPresetV1) {
    const label = epLabel.trim() || preset.model;
    if (label !== preset.label) applyPresetUpdate(preset.id, { label });
  }

  // Changing the provider commits immediately ("select = commit") but keeps
  // the row open, since the model choice from the old provider no longer
  // applies and needs to be re-picked.
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

  function isPresetActive(preset: ModelPresetV1): boolean {
    return settings.presetId === preset.id || (!settings.presetId && preset.id === sharedConfig.defaultPresetId);
  }

  function renderProviderRow(provider: LlmProviderV1) {
    const isEditing = editingProviderId === provider.id;
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
      <div class="llm-row" key={provider.id}>
        <button type="button" class="llm-row-main" onClick={() => handleOpenEditProvider(provider)}>
          <span class="llm-row-label">{provider.label || hostLabel}</span>
          <span class="llm-row-model">{hostLabel}</span>
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
    const isActive = isPresetActive(preset);

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

    return (
      <div class={`llm-row${isActive ? " llm-row-active" : ""}`} key={preset.id}>
        <button
          type="button"
          class="llm-row-main"
          title={t("settings-llm-select-model-title")}
          onClick={() => updateLanguage({ presetId: preset.id })}
        >
          <span class="llm-row-label">{preset.label}</span>
          <span class="llm-row-model">{preset.model}</span>
          <span class="llm-row-provider">{getProviderLabel(preset.providerId)}</span>
        </button>
        {isActive ? <span class="llm-row-badge">{t("settings-llm-active-badge")}</span> : null}
        <div class="llm-row-icons">
          <button
            type="button"
            class="llm-icon-button llm-row-edit"
            title={t("settings-llm-edit-title")}
            onClick={(e) => {
              e.stopPropagation();
              handleOpenEditPreset(preset);
            }}
          >
            <Pencil size={13} />
          </button>
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
            {target ? (
              <p class="hint-text status-ok">
                {t("settings-llm-current-connection", { label: target.label, model: target.model })}
              </p>
            ) : (
              <p class="hint-text status-warn">{t("settings-llm-no-connection")}</p>
            )}

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
              {sharedConfig.providers.length === 0 ? (
                <p class="hint-text">{t("settings-llm-models-need-provider")}</p>
              ) : null}
              {sharedConfig.providers.length > 0 && sharedConfig.presets.length === 0 && !addingModel ? (
                <p class="hint-text">{t("settings-llm-models-empty")}</p>
              ) : null}
              <div class="llm-row-list">
                {sharedConfig.presets.map((preset) => renderModelRow(preset))}
                {renderAddModelTile()}
              </div>
            </div>
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
              {ttsOptionsLoading ? (
                <select disabled>
                  <option>{t("settings-llm-model-loading")}</option>
                </select>
              ) : ttsModelOptions ? (
                <select
                  value={sharedConfig.tts?.model ?? ""}
                  onChange={(e) => updateTts({ model: (e.target as HTMLSelectElement).value })}
                >
                  <option value="" disabled>
                    {t("settings-llm-model-select-placeholder")}
                  </option>
                  {sharedConfig.tts?.model && !ttsModelOptions.includes(sharedConfig.tts.model) && (
                    <option value={sharedConfig.tts.model}>{sharedConfig.tts.model}</option>
                  )}
                  {ttsModelOptions.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={sharedConfig.tts?.model ?? ""}
                  onInput={(e) => updateTts({ model: (e.target as HTMLInputElement).value })}
                  placeholder={t("settings-tts-model-placeholder")}
                />
              )}
            </label>

            <label>
              {t("settings-tts-voice-label")}
              {ttsOptionsLoading ? (
                <select disabled>
                  <option>{t("settings-llm-model-loading")}</option>
                </select>
              ) : ttsVoiceOptions ? (
                <select
                  value={sharedConfig.tts?.voice ?? ""}
                  onChange={(e) => updateTts({ voice: (e.target as HTMLSelectElement).value || undefined })}
                >
                  {/* voice is optional (resolveVoice omits it) — the empty
                      choice means "let the server pick". */}
                  <option value="">{t("settings-tts-voice-default")}</option>
                  {sharedConfig.tts?.voice && !ttsVoiceOptions.includes(sharedConfig.tts.voice) && (
                    <option value={sharedConfig.tts.voice}>{sharedConfig.tts.voice}</option>
                  )}
                  {ttsVoiceOptions.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    type="text"
                    list="tc-lingo-tts-voice-options"
                    value={sharedConfig.tts?.voice ?? ""}
                    onInput={(e) => updateTts({ voice: (e.target as HTMLInputElement).value })}
                    placeholder={t("settings-tts-voice-placeholder")}
                  />
                  <datalist id="tc-lingo-tts-voice-options">
                    {OPENAI_TTS_VOICES.map((voice) => (
                      <option key={voice} value={voice} />
                    ))}
                  </datalist>
                </>
              )}
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
