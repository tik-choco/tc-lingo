import { MistBuildBanner } from "../components/MistBuildBanner";
import { useEffect, useState } from "preact/hooks";
import { Sparkles, Volume2, X } from "lucide-preact";
import { LlmSettings, Switch, useLlmConfig } from "@tik-choco/mistai/preact";
import { loadSettings, subscribeSettings, llmLocalAdapter, addTargetLanguage, removeTargetLanguage,
  saveSettings, setAutoExtractCards, setShowReadingAids, setAutoOrganizeCards, setTtsVoiceOverride, voiceRefKey } from "../lib/settings";
import { resolveVoice } from "../lib/llmConfig";
import { languageVoiceRows } from "../lib/ttsVoiceByLanguage";
import { LLM_TASKS } from "../lib/llmConnection";
import { CEFR_BANDS, computedBand, loadLevels, setLevelOverride, subscribeLevels } from "../lib/level";
import type { CefrBand } from "../types";
import { languageDisplayName } from "../lib/languages";
import { LanguageSelect } from "../components/LanguageSelect";
import { requestOnboarding } from "../lib/onboarding";
import { useSpeech } from "../hooks/useSpeech";
import { getSyncState } from "../lib/sync/session";
import { SyncPanel } from "../components/SyncPanel";
import { getUiLanguage, t } from "../i18n";

const MIN_LEVEL_SAMPLES = 3;
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


export function AiSettings() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const { config } = useLlmConfig();
  const speech = useSpeech();
  const target = resolveVoice(config, "tts");
  const rows = languageVoiceRows([...settings.targetLanguages, settings.nativeLanguage]);
  const voices = target ? settings.ttsVoicesByRef[voiceRefKey(target)] ?? {} : {};
  return <LlmSettings
    tasks={LLM_TASKS.map(id => ({ id, label: t("ai-task-" + id), reasoning: id !== "card-organize" }))}
    localSettings={llmLocalAdapter}
    voice={{ tts: {} }}
    locale={getUiLanguage()}
    extraSections={tab => tab === "tasks" && <section class="card-panel lingo-voice-settings">
      <div class="button-row"><button type="button" disabled={!speech.supported}
        onClick={() => speech.speak(TTS_SAMPLE_TEXT[settings.activeLanguage] ?? TTS_SAMPLE_TEXT.English, settings.activeLanguage, TTS_TEST_ID)}>
        <Volume2 size={15} />{speech.loadingId === TTS_TEST_ID ? t("settings-tts-test-loading") : speech.speakingId === TTS_TEST_ID ? t("settings-tts-test-stop") : t("settings-tts-test-button")}
      </button></div>
      {speech.speechError && <p class="error-text">{speech.speechError}</p>}
      {target && rows.length > 0 && <div class="field-grid">
        <h3 class="settings-subheading">{t("settings-tts-per-language-heading")}</h3>
        <p class="hint-text">{t("settings-tts-per-language-hint")}</p>
        {rows.map(row => {
          const label = row.languages.map(languageDisplayName).join(" / ");
          return <label class="lingo-voice-row" key={voiceRefKey(target) + row.subtag}>
            <span>{label}</span><input type="text" value={voices[row.subtag] ?? ""}
              placeholder={t("settings-tts-per-language-voice-placeholder")}
              aria-label={t("settings-tts-per-language-voice-aria-label", { language: label })}
              onBlur={event => setTtsVoiceOverride(target, row.subtag, event.currentTarget.value)}
              onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          </label>;
        })}
      </div>}
    </section>} />;
}

type SettingsTab = "general" | "ai" | "sync";
const TABS: { id: SettingsTab; labelKey: string }[] = [
  { id: "general", labelKey: "settings-tab-general" }, { id: "ai", labelKey: "ai-settings" }, { id: "sync", labelKey: "settings-tab-sync" },
];

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const state = getSyncState();
    return state.pendingJoinRoomId || state.phase !== "idle" ? "sync" : "general";
  });
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const [levelRecords, setLevelRecords] = useState(loadLevels);
  useEffect(() => subscribeLevels(() => setLevelRecords(loadLevels())), []);
  function updateLanguage(patch: Partial<typeof settings>) { saveSettings({ ...loadSettings(), ...patch }); }
  return <div class="view-container settings-view">
    <div class="lingo-settings-tab-bar" role="tablist" aria-label={t("settings-tabs-aria-label")}>
      {TABS.map(tab => <button key={tab.id} type="button" role="tab" class={"lingo-settings-tab" + (activeTab === tab.id ? " active" : "")}
        aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>{t(tab.labelKey)}</button>)}
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
              <div class="toggle-row">
                <Switch label={t("settings-auto-extract-label")} checked={settings.autoExtractCards} onChange={setAutoExtractCards} />
                {t("settings-auto-extract-label")}
              </div>
              <p class="hint-text">{t("settings-auto-extract-hint")}</p>
            </div>

            <div class="field-grid">
              <div class="toggle-row">
                <Switch label={t("settings-reading-aids-label")} checked={settings.showReadingAids} onChange={setShowReadingAids} />
                {t("settings-reading-aids-label")}
              </div>
              <p class="hint-text">{t("settings-reading-aids-hint")}</p>
            </div>

            <div class="field-grid">
              <div class="toggle-row">
                <Switch label={t("settings-auto-organize-label")} checked={settings.autoOrganizeCards} onChange={setAutoOrganizeCards} />
                {t("settings-auto-organize-label")}
              </div>
              <p class="hint-text">{t("settings-auto-organize-hint")}</p>
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


    {activeTab === "ai" && <div class="settings-tab-panel" role="tabpanel"><AiSettings /></div>}
    {activeTab === "sync" && <div class="settings-tab-panel" role="tabpanel"><SyncPanel /></div>}
    <footer style={{ padding: "12px 0" }}><MistBuildBanner view="settings" /></footer>
  </div>;
}
