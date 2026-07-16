import type { MessageBundle } from "./types";

export const reviewMessages = {
  en: {
    "review-title": "Review",
    "review-refresh-title": "Refresh queue",
    "review-empty-hint":
      "There are no cards due for review right now. Cards created from mistakes on the Practice tab will show up here.",
    "review-session-done": "Nice work — you reviewed {count} card(s).",
    "review-reveal-answer": "Show answer",
    "review-grade-again": "Again",
    "review-grade-hard": "Hard",
    "review-grade-good": "Good",
    "review-grade-easy": "Easy",
  },
  ja: {
    "review-title": "復習",
    "review-refresh-title": "キューを更新",
    "review-empty-hint": "今復習すべきカードはありません。練習タブで間違いをカード化するとここに追加されます。",
    "review-session-done": "お疲れさまでした。{count}枚を復習しました。",
    "review-reveal-answer": "答えを見る",
    "review-grade-again": "もう一度",
    "review-grade-hard": "難しい",
    "review-grade-good": "できた",
    "review-grade-easy": "簡単",
  },
  "zh-CN": {
    "review-title": "复习",
    "review-refresh-title": "刷新队列",
    "review-empty-hint": "目前没有需要复习的卡片。在练习标签页中将错误制作成卡片后,会显示在这里。",
    "review-session-done": "辛苦了,你已复习了 {count} 张卡片。",
    "review-reveal-answer": "查看答案",
    "review-grade-again": "再来一次",
    "review-grade-hard": "困难",
    "review-grade-good": "掌握",
    "review-grade-easy": "简单",
  },
  "zh-TW": {
    "review-title": "複習",
    "review-refresh-title": "重新整理佇列",
    "review-empty-hint": "目前沒有需要複習的卡片。在練習分頁中將錯誤製作成卡片後,會顯示在這裡。",
    "review-session-done": "辛苦了,你已複習了 {count} 張卡片。",
    "review-reveal-answer": "查看答案",
    "review-grade-again": "再一次",
    "review-grade-hard": "困難",
    "review-grade-good": "掌握",
    "review-grade-easy": "簡單",
  },
} satisfies MessageBundle;
