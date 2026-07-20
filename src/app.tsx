import { useEffect, useRef, useState } from "preact/hooks";
import "@tik-choco/mistai/ui.css";
import {
  BookOpen,
  ExternalLink,
  History,
  Keyboard,
  Languages,
  Layers,
  MessagesSquare,
  Moon,
  PenLine,
  Repeat2,
  Settings as SettingsIcon,
  Sun,
} from "lucide-preact";
import type { MainTab } from "./types";
import { familyAppUrl } from "./lib/familyApps";
import { onHashChange, readHash, writeHash } from "./lib/hashRoute";
import type { HashState } from "./lib/hashRoute";
import { requestSyncJoin } from "./lib/sync/session";
import { useTheme } from "./hooks/useTheme";
import { paneEnterClass, useEnterDirection } from "./hooks/useEnterDirection";
import { PracticeView } from "./views/PracticeView";
import { ReadingView } from "./views/ReadingView";
import { TalkView } from "./views/TalkView";
import { ReviewView } from "./views/ReviewView";
import { CardsView } from "./views/CardsView";
import { HistoryView } from "./views/HistoryView";
import { SettingsView } from "./views/SettingsView";
import { Onboarding } from "./components/Onboarding";
import { KeyboardHelp } from "./components/KeyboardHelp";
import { markOnboardingDone, shouldShowOnboarding, subscribeOnboardingRequests } from "./lib/onboarding";
import { loadSettings, setActiveLanguage, subscribeSettings } from "./lib/settings";
import { languageDisplayName } from "./lib/languages";
import { applyUiLanguageForNative, getUiSourceMessages, setUiOverlay, subscribeUiMessages, t } from "./i18n";
import { translateUiMessages } from "./lib/uiTranslation";
import { useLlmConnection } from "./hooks/useLlmConnection";
import { connectionForTask } from "./lib/llmConnection";
import { emptyLlmConfig } from "./lib/llmConfig";
import { deriveVoiceEngine } from "./lib/voice";
import { useNetworkConsumerConnection } from "./hooks/useNetworkConsumerConnection";
import { useNetworkConsumerStatus } from "./hooks/useNetworkConsumerStatus";
import { useNetworkProvider } from "./hooks/useNetworkProvider";
import { useNetworkModelSync } from "./hooks/useNetworkModelSync";
import { isEditableTarget, SHORTCUT_PRIORITY } from "./lib/keyboard";
import { useShortcuts } from "./hooks/useShortcuts";

// `#/sync/<roomId>` deep link (opened e.g. by scanning the sync QR code):
// stage the join for 設定 > 同期 to confirm, and rewrite the hash immediately
// so a refresh doesn't re-trigger the prompt. Called synchronously — both
// where `tab` is first computed (so SettingsView's own initial-tab check,
// which reads getSyncState() at mount, sees pendingJoinRoomId already set —
// a useEffect would run too late, after SettingsView's first render) and
// from the hashchange handler for a same-session navigation.
function handleSyncDeepLink(state: HashState) {
  if (!state.syncRoomId) return;
  requestSyncJoin(state.syncRoomId);
  writeHash("settings");
}

const TABS: { id: MainTab; labelKey: string; icon: typeof PenLine }[] = [
  { id: "practice", labelKey: "app-tab-practice", icon: PenLine },
  { id: "reading", labelKey: "app-tab-reading", icon: BookOpen },
  { id: "talk", labelKey: "app-tab-talk", icon: MessagesSquare },
  { id: "review", labelKey: "app-tab-review", icon: Repeat2 },
  { id: "cards", labelKey: "app-tab-cards", icon: Layers },
  { id: "history", labelKey: "app-tab-history", icon: History },
  { id: "settings", labelKey: "app-tab-settings", icon: SettingsIcon },
];

const TAB_ORDER = TABS.map((t) => t.id);

export function App() {
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState<MainTab>(() => {
    const state = readHash();
    handleSyncDeepLink(state);
    return state.tab ?? "practice";
  });
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const dir = useEnterDirection(TAB_ORDER, tab);
  const mainRef = useRef<HTMLElement>(null);

  // The UI language follows the native language (i18n/index.ts). Re-render
  // the whole tree whenever the active message table changes (language
  // switch, or an LLM-translated overlay arriving).
  const { target, mode, roomId, config } = useLlmConnection();
  const [, setMessagesVersion] = useState(0);
  useEffect(() => subscribeUiMessages(() => setMessagesVersion((v) => v + 1)), []);

  // Eagerly (re)connects the AI Network consumer session whenever that's the
  // configured transport for chat/correction (connectionMode) OR for
  // read-aloud (the TTS engine — always DERIVED from the shared config, see
  // lib/voice.ts's deriveVoiceEngine — never a stored setting), instead of
  // waiting for the first LLM/TTS call to join the room lazily. Reconnects on
  // a room id change, disconnects once neither feature is pointed at the
  // network and the room id is cleared.
  useNetworkConsumerConnection({
    enabled: (mode === "network" || deriveVoiceEngine(config ?? emptyLlmConfig(), "tts") === "network") && roomId !== "",
    roomId,
  });

  // "Participate as an AI Network provider" (settings.networkProviderEnabled)
  // and "mirror the room's advertised models into the shared config as
  // presets" (see hooks/useNetworkModelSync.ts) both need to run regardless
  // of which tab is open, same as the consumer connection above — there's no
  // per-app orchestrating hook like tc-translate's useTranslator.ts here
  // (views are self-contained, see CLAUDE.md), so this shell owns both.
  useNetworkProvider(settings, config ?? emptyLlmConfig());
  const consumerStatus = useNetworkConsumerStatus();
  useNetworkModelSync(settings, consumerStatus, roomId);

  // Languages without a built-in dictionary get their UI strings translated
  // once by the configured LLM and cached; until that resolves (or if no LLM
  // is configured/reachable) the UI shows English.
  const uiTranslationInFlight = useRef("");
  useEffect(() => {
    if (applyUiLanguageForNative(settings.nativeLanguage) !== "needs-translation") return;
    const conn = connectionForTask("ui-translation");
    if (!conn) return;
    const language = settings.nativeLanguage;
    if (uiTranslationInFlight.current === language) return;
    uiTranslationInFlight.current = language;
    void translateUiMessages({ connection: conn, language, messages: getUiSourceMessages() })
      .then((messages) => setUiOverlay(language, messages))
      .catch(() => {
        // No usable LLM or an unparsable answer: the UI stays in English.
      })
      .finally(() => {
        if (uiTranslationInFlight.current === language) uiTranslationInFlight.current = "";
      });
    // `connection` is a freshly-allocated object on every resolve, so depend
    // on its stable identity fields instead (mode + which target/room it
    // points at) to avoid re-running this effect on every unrelated
    // re-resolve (e.g. an unrelated settings change firing subscribeSettings).
  }, [settings.nativeLanguage, mode, target?.presetId, roomId]);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [tab]);

  useEffect(
    () =>
      onHashChange((state) => {
        if (state.tab) setTab(state.tab);
        handleSyncDeepLink(state);
      }),
    [],
  );

  function selectTab(next: MainTab) {
    setTab(next);
    writeHash(next);
  }

  // First-run wizard: shown once on a fresh install, and re-openable from the
  // settings screen. Closing it (any path) marks onboarding done.
  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding());
  useEffect(() => subscribeOnboardingRequests(() => setShowOnboarding(true)), []);

  function closeOnboarding() {
    markOnboardingDone();
    setShowOnboarding(false);
  }

  // App-wide keyboard shortcuts: 1-7 switch tabs (and move focus into the
  // main pane so arrow/scroll keys land there), "?" toggles the cheat
  // sheet. Lowest priority tier — anything typed into an input, or any
  // modifier combo, is left alone so browser/OS shortcuts and view-level
  // handlers (e.g. Ctrl+Enter to submit) still work; a view or modal
  // registered at a higher priority runs first regardless.
  const [showKbdHelp, setShowKbdHelp] = useState(false);
  useShortcuts(SHORTCUT_PRIORITY.app, (e) => {
    if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (/^[1-9]$/.test(e.key)) {
      const next = TAB_ORDER[Number(e.key) - 1];
      if (next) {
        selectTab(next);
        mainRef.current?.focus();
        return true;
      }
    }
    if (e.key === "?") {
      setShowKbdHelp((v) => !v);
      return true;
    }
    return false;
  });

  return (
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header-brand">
          <Languages size={20} />
          <span>TC Lingo</span>
        </div>
        <nav class="app-tabs">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              class={`app-tab${tab === id ? " app-tab-active" : ""}`}
              onClick={() => selectTab(id)}
            >
              <Icon size={16} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>
        <div class="app-header-links">
          {settings.targetLanguages.length > 1 && (
            <div class="language-switcher">
              {settings.targetLanguages.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  class={`language-switcher-chip${lang === settings.activeLanguage ? " active" : ""}`}
                  onClick={() => {
                    setActiveLanguage(lang);
                    setSettings(loadSettings());
                  }}
                >
                  {languageDisplayName(lang)}
                </button>
              ))}
            </div>
          )}
          <a
            class="theme-toggle"
            href={familyAppUrl("tc-translate")}
            target="_blank"
            rel="noopener noreferrer"
            title={t("app-open-translate")}
            aria-label={t("app-open-translate")}
          >
            <ExternalLink size={16} />
          </a>
          <button
            class="theme-toggle"
            onClick={() => setShowKbdHelp(true)}
            title={t("app-kbd-help-button")}
            aria-label={t("app-kbd-help-button")}
          >
            <Keyboard size={16} />
          </button>
          <button
            class="theme-toggle"
            onClick={toggleTheme}
            title={theme === "light" ? t("app-theme-toggle-dark") : t("app-theme-toggle-light")}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>
      <main class="app-main" ref={mainRef} tabIndex={-1}>
        <div key={tab} class={paneEnterClass(dir)} style={{ height: "100%" }}>
          {tab === "practice" && <PracticeView />}
          {tab === "reading" && <ReadingView />}
          {tab === "talk" && <TalkView />}
          {tab === "review" && <ReviewView />}
          {tab === "cards" && <CardsView />}
          {tab === "history" && <HistoryView />}
          {tab === "settings" && <SettingsView />}
        </div>
      </main>
      {showOnboarding && <Onboarding onClose={closeOnboarding} />}
      {showKbdHelp && <KeyboardHelp onClose={() => setShowKbdHelp(false)} />}
    </div>
  );
}
