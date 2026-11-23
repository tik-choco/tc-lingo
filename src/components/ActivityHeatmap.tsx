import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { getUiLanguage, t } from "../i18n";
import { activityLevel, buildActivity } from "../lib/activity";
import { loadReviewActivity } from "../lib/activityLog";
import { loadCards } from "../lib/cards";
import { loadConversations } from "../lib/conversation";
import { loadPassages } from "../lib/reading";
import { loadSettings } from "../lib/settings";
import { subscribeStorage } from "../lib/storage";
import { loadAttempts, loadTopics } from "../lib/topics";

const categories = [
  ["review", "history-activity-review"],
  ["practice", "history-activity-practice"],
  ["reading", "history-activity-reading"],
  ["talk", "history-activity-talk"],
] as const;

export function ActivityHeatmap() {
  const [revision, setRevision] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The cards, topics, passages, conversations and settings subscriptions all
    // use this same channel, which also reports changes to the review log.
    const unsubscribe = subscribeStorage(() => setRevision((value) => value + 1));
    loadReviewActivity(loadCards);
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, []);

  const activity = useMemo(() => buildActivity({
    reviews: loadReviewActivity().days,
    topics: loadTopics(),
    attempts: loadAttempts(),
    passages: loadPassages(),
    conversations: loadConversations(),
  }, loadSettings().activeLanguage, new Date()), [revision]);

  const { days } = activity;
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));
  const uiLanguage = getUiLanguage();
  const dateFormat = new Intl.DateTimeFormat(uiLanguage, { year: "numeric", month: "long", day: "numeric" });
  const numberFormat = new Intl.NumberFormat(uiLanguage);
  const title = t("history-activity-title");

  return (
    <>
      <header>
        <h2>{title}</h2>
        <p class="hint-text">{t("history-activity-stats", {
          total: numberFormat.format(activity.total),
          activeDays: numberFormat.format(activity.activeDays),
          current: numberFormat.format(activity.currentStreak),
          longest: numberFormat.format(activity.longestStreak),
        })}</p>
      </header>
      <div class="activity-heatmap-scroll" ref={scroll} role="region" aria-label={title} tabIndex={0}>
        <div class="activity-heatmap-grid">
          <div class="activity-heatmap-weekdays" aria-hidden="true">
            <span />
            {weeks[0].map(({ date, key }, index) => (
              <span key={key}>
                {index % 2 === 1 ? date.toLocaleDateString(uiLanguage, { weekday: "short" }) : null}
              </span>
            ))}
          </div>
          {weeks.map((week) => {
            const monthStart = week.find(({ date }) => date.getDate() === 1);
            return (
              <div class="activity-heatmap-week" key={week[0].key}>
                <span class="activity-heatmap-month" aria-hidden="true">
                  {monthStart?.date.toLocaleDateString(uiLanguage, { month: "short" })}
                </span>
                {week.map((day) => {
                  const date = dateFormat.format(day.date);
                  const parts = categories.flatMap(([category, key]) => {
                    const count = day[category];
                    return count ? [t(key, { count: numberFormat.format(count) })] : [];
                  });
                  const label = parts.length
                    ? t("history-activity-day", { date, activities: parts.join(" · ") })
                    : t("history-activity-day-empty", { date });
                  return (
                    <span
                      key={day.key}
                      class="activity-heatmap-cell"
                      data-level={activityLevel(day.total, activity.max)}
                      role="img"
                      title={label}
                      aria-label={label}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div class="activity-heatmap-legend" aria-hidden="true">
        <span>{t("history-activity-less")}</span>
        {[0, 1, 2, 3, 4].map((level) => <span class="activity-heatmap-cell" key={level} data-level={level} />)}
        <span>{t("history-activity-more")}</span>
      </div>
    </>
  );
}
