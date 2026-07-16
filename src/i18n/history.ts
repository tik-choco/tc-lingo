import type { MessageBundle } from "./types";

export const historyMessages = {
  en: {
    "history-empty-state": "No topics yet. Start from the Practice tab.",
    "history-delete-topic": "Delete this topic",
    "history-round-label": "Round {round}",
    "history-diff-heading": "Diff vs. previous correction (this round's original)",
    "history-retry-answer-heading": "Retry answer",
  },
  ja: {
    "history-empty-state": "まだトピックがありません。練習タブから始めてみましょう。",
    "history-delete-topic": "このトピックを削除",
    "history-round-label": "ラウンド{round}",
    "history-diff-heading": "前回の修正版との差分(このラウンドの原文)",
    "history-retry-answer-heading": "再回答",
  },
  "zh-CN": {
    "history-empty-state": "还没有主题。请从练习标签开始吧。",
    "history-delete-topic": "删除此主题",
    "history-round-label": "第{round}轮",
    "history-diff-heading": "与上次修正版的差异(本轮的原文)",
    "history-retry-answer-heading": "再次作答",
  },
  "zh-TW": {
    "history-empty-state": "還沒有主題。請從練習標籤開始吧。",
    "history-delete-topic": "刪除此主題",
    "history-round-label": "第{round}輪",
    "history-diff-heading": "與上次修正版的差異(本輪的原文)",
    "history-retry-answer-heading": "再次作答",
  },
} satisfies MessageBundle;
