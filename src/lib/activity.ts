import type { ConversationSession, PracticeAttempt, ReadingPassage, Topic } from "../types";
import { localDateKey } from "./activityLog";
import type { ReviewActivity } from "./activityLog";

type ActivityCategory = "review" | "practice" | "reading" | "talk";

interface ActivityDay extends Record<ActivityCategory | "total", number> {
  date: Date;
  key: string;
}

interface ActivitySources {
  reviews: ReviewActivity["days"];
  topics: readonly Pick<Topic, "id" | "language">[];
  attempts: readonly Pick<PracticeAttempt, "topicId" | "createdAt">[];
  passages: readonly Pick<ReadingPassage, "language" | "createdAt">[];
  conversations: readonly Pick<ConversationSession, "language" | "createdAt" | "turns">[];
}

export function activityLevel(total: number, max: number): number {
  return total === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(4 * total / max)));
}

export function buildActivity(sources: ActivitySources, activeLanguage: string, today: Date) {
  const first = new Date(today);
  const daysBeforeToday = 52 * 7 + today.getDay();
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - daysBeforeToday);

  const days = Array.from({ length: daysBeforeToday + 1 }, (_, offset): ActivityDay => {
    const date = new Date(first);
    date.setDate(first.getDate() + offset);
    return { date, key: localDateKey(date), review: 0, practice: 0, reading: 0, talk: 0, total: 0 };
  });
  const daysByKey = new Map(days.map((day) => [day.key, day]));

  function matchesLanguage(language: string): boolean {
    return !activeLanguage || !language || language === activeLanguage;
  }

  function add(createdAt: string, category: ActivityCategory, count = 1): void {
    const day = daysByKey.get(localDateKey(new Date(createdAt)));
    if (day) day[category] += count;
  }

  for (const day of days) {
    for (const [language, count] of Object.entries(sources.reviews[day.key] ?? {})) {
      if (matchesLanguage(language)) day.review += count;
    }
  }
  const topicLanguages = new Map(sources.topics.map((topic) => [topic.id, topic.language]));
  for (const attempt of sources.attempts) {
    const language = topicLanguages.get(attempt.topicId);
    if (language !== undefined && matchesLanguage(language)) add(attempt.createdAt, "practice");
  }
  for (const passage of sources.passages) {
    if (matchesLanguage(passage.language)) add(passage.createdAt, "reading");
  }
  for (const session of sources.conversations) {
    if (!matchesLanguage(session.language)) continue;
    const learnerTurns = session.turns.reduce((count, turn) => count + Number(turn.role === "learner"), 0);
    add(session.createdAt, "talk", learnerTurns);
  }

  let total = 0;
  let max = 0;
  let activeDays = 0;
  let currentStreak = 0;
  let longestStreak = 0;
  const todayKey = localDateKey(today);
  for (const day of days) {
    day.total = day.review + day.practice + day.reading + day.talk;
    total += day.total;
    max = Math.max(max, day.total);
    if (day.total > 0) {
      activeDays++;
      currentStreak++;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else if (day.key !== todayKey) {
      currentStreak = 0;
    }
  }

  return { days, total, max, activeDays, currentStreak, longestStreak };
}
