import { useEffect, useRef, useState } from "preact/hooks";
import { History, Languages, Layers, Moon, PenLine, Repeat2, Settings as SettingsIcon, Sun } from "lucide-preact";
import type { MainTab } from "./types";
import { onHashChange, readHash, writeHash } from "./lib/hashRoute";
import { useTheme } from "./hooks/useTheme";
import { paneEnterClass, useEnterDirection } from "./hooks/useEnterDirection";
import { PracticeView } from "./views/PracticeView";
import { ReviewView } from "./views/ReviewView";
import { CardsView } from "./views/CardsView";
import { HistoryView } from "./views/HistoryView";
import { SettingsView } from "./views/SettingsView";
import { Onboarding } from "./components/Onboarding";
import { markOnboardingDone, shouldShowOnboarding, subscribeOnboardingRequests } from "./lib/onboarding";
import { loadSettings, setActiveLanguage, subscribeSettings } from "./lib/settings";
import { languageDisplayName } from "./lib/languages";

const TABS: { id: MainTab; label: string; icon: typeof PenLine }[] = [
  { id: "practice", label: "練習", icon: PenLine },
  { id: "review", label: "復習", icon: Repeat2 },
  { id: "cards", label: "カード", icon: Layers },
  { id: "history", label: "履歴", icon: History },
  { id: "settings", label: "設定", icon: SettingsIcon },
];

const TAB_ORDER = TABS.map((t) => t.id);

export function App() {
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState<MainTab>(() => readHash().tab ?? "practice");
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  const dir = useEnterDirection(TAB_ORDER, tab);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [tab]);

  useEffect(
    () =>
      onHashChange((state) => {
        if (state.tab) setTab(state.tab);
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

  return (
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header-brand">
          <Languages size={20} />
          TC Lingo
        </div>
        <nav class="app-tabs">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              class={`app-tab${tab === id ? " app-tab-active" : ""}`}
              onClick={() => selectTab(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
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
          <button
            class="theme-toggle"
            onClick={toggleTheme}
            title={theme === "light" ? "ダークテーマに切り替え" : "ライトテーマに切り替え"}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>
      <main class="app-main" ref={mainRef}>
        <div key={tab} class={paneEnterClass(dir)} style={{ height: "100%" }}>
          {tab === "practice" && <PracticeView />}
          {tab === "review" && <ReviewView />}
          {tab === "cards" && <CardsView />}
          {tab === "history" && <HistoryView />}
          {tab === "settings" && <SettingsView />}
        </div>
      </main>
      {showOnboarding && <Onboarding onClose={closeOnboarding} />}
    </div>
  );
}
