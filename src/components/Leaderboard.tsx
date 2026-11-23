import { Flame } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { getUiLanguage, t } from "../i18n";
import { languageDisplayName } from "../lib/languages";
import { LEADERBOARD_NAME_MAX_LENGTH, normalizeLeaderboardName } from "../lib/leaderboard/protocol";
import { getLeaderboardState, subscribeLeaderboard } from "../lib/leaderboard/session";
import { loadSettings, saveSettings, subscribeSettings } from "../lib/settings";

const periods = [
  ["today", "history-leaderboard-today"],
  ["week", "history-leaderboard-week"],
  ["month", "history-leaderboard-month"],
] as const;
type Period = (typeof periods)[number][0];

export function Leaderboard() {
  const [state, setState] = useState(getLeaderboardState);
  const [settings, setSettings] = useState(loadSettings);
  const [name, setName] = useState(settings.leaderboardName);
  const [period, setPeriod] = useState<Period>("week");

  useEffect(() => {
    const update = () => setState(getLeaderboardState());
    const unsubscribe = subscribeLeaderboard(update);
    update();
    return unsubscribe;
  }, []);
  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);
  useEffect(() => setName(settings.leaderboardName), [settings.leaderboardName]);

  function saveName(value: string) {
    const leaderboardName = normalizeLeaderboardName(value);
    setName(leaderboardName);
    const current = loadSettings();
    if (leaderboardName !== current.leaderboardName) saveSettings({ ...current, leaderboardName });
  }

  const locale = getUiLanguage();
  const numberFormat = new Intl.NumberFormat(locale);
  const anonymous = t("history-leaderboard-anonymous");
  const rows = state.self ? [state.self, ...state.peers] : [...state.peers];
  rows.sort((a, b) => (
    b.stats[period] - a.stats[period] || b.stats.streak - a.stats.streak ||
    (a.name || anonymous).localeCompare(b.name || anonymous, locale) || a.id.localeCompare(b.id)
  ));

  return (
    <section class="card-panel" aria-labelledby="leaderboard-title">
      <h2 id="leaderboard-title">{t("history-leaderboard-title")}</h2>
      <div class="leaderboard-controls">
        <label class="leaderboard-opt-in">
          <input
            type="checkbox"
            checked={settings.leaderboardEnabled}
            aria-describedby="leaderboard-sharing"
            onChange={(event) => saveSettings({ ...loadSettings(), leaderboardEnabled: event.currentTarget.checked })}
          />
          {t("history-leaderboard-opt-in")}
        </label>
        <label class="leaderboard-name">
          {t("history-leaderboard-display-name")}
          <input
            type="text"
            value={name}
            maxLength={LEADERBOARD_NAME_MAX_LENGTH}
            placeholder={anonymous}
            onInput={(event) => setName(event.currentTarget.value)}
            onBlur={(event) => saveName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) event.currentTarget.blur();
            }}
          />
        </label>
      </div>
      <p id="leaderboard-sharing" class="hint-text leaderboard-room" dir="auto">
        {state.roomId ? t("history-leaderboard-sharing-room", { roomId: state.roomId }) : t("history-leaderboard-sharing")}
      </p>
      <div class="leaderboard-status" role="status">
        {!state.roomId && <p class="hint-text">{t("history-leaderboard-no-room")}</p>}
        {state.status === "connecting" && <p class="hint-text">{t("history-leaderboard-connecting")}</p>}
        {state.error && <p class="hint-text leaderboard-error">{t(state.error)}</p>}
        {state.status === "connected" && state.peers.length === 0 && (
          <p class="hint-text">{t("history-leaderboard-empty")}</p>
        )}
      </div>
      {state.status === "connected" && (
        <>
          <div class="leaderboard-periods" role="group" aria-label={t("history-leaderboard-period")}>
            {periods.map(([value, label]) => (
              <button type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>
                {t(label)}
              </button>
            ))}
          </div>
          <p class="hint-text">{t("history-leaderboard-count-hint")}</p>
          <ol class="leaderboard-list" role="list">
            {rows.map(({ id, name: displayName, language, stats }, index) => {
              const self = id === state.selfId;
              const localizedLanguage = languageDisplayName(language);
              return (
                <li key={id} class={self ? "leaderboard-row leaderboard-self" : "leaderboard-row"}>
                  <span class="leaderboard-rank">{numberFormat.format(index + 1)}</span>
                  <div class="leaderboard-person">
                    <div>
                      <bdi>{displayName || anonymous}</bdi>
                      {self && <span class="leaderboard-you">{t("history-leaderboard-you")}</span>}
                    </div>
                    {language && (
                      <bdi class="leaderboard-language">{typeof localizedLanguage === "string" ? localizedLanguage : language}</bdi>
                    )}
                  </div>
                  <div class="leaderboard-results">
                    <strong>{t("history-leaderboard-count", { count: numberFormat.format(stats[period]) })}</strong>
                    <span class="leaderboard-streak">
                      <Flame size={14} aria-hidden="true" />
                      <span>{t("history-leaderboard-streak", { count: numberFormat.format(stats.streak) })}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
