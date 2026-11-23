import { buildActivity } from "../activity";
import { loadAllReviewDays } from "../activityLog";
import { loadConversations } from "../conversation";
import { loadPassages } from "../reading";
import { loadAttempts, loadTopics } from "../topics";
import { clampCount } from "./protocol";
import type { LeaderboardStats } from "./protocol";

function reviewDays() {
  return loadAllReviewDays();
}

export function computeLeaderboardStats(sources: Parameters<typeof buildActivity>[0], today: Date): LeaderboardStats {
  const { days, currentStreak } = buildActivity(sources, "", today);
  const total = (dayCount: number) => clampCount(days.slice(-dayCount).reduce((sum, day) => sum + day.total, 0));
  return {
    today: total(1),
    week: total(7),
    month: total(30),
    streak: currentStreak,
    activeDays: days.slice(-365).filter((day) => day.total > 0).length,
  };
}

export function loadLeaderboardStats(): LeaderboardStats {
  return computeLeaderboardStats({
    reviews: reviewDays(),
    topics: loadTopics(),
    attempts: loadAttempts(),
    passages: loadPassages(),
    conversations: loadConversations(),
  }, new Date());
}
