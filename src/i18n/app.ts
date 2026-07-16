import type { MessageBundle } from "./types";

// App shell (tabs, header) i18n bundle. Keys are prefixed "app-".
export const appMessages = {
  en: {
    "app-tab-practice": "Practice",
    "app-tab-review": "Review",
    "app-tab-cards": "Cards",
    "app-tab-history": "History",
    "app-tab-settings": "Settings",
    "app-theme-toggle-dark": "Switch to dark theme",
    "app-theme-toggle-light": "Switch to light theme",
  },
  ja: {
    "app-tab-practice": "練習",
    "app-tab-review": "復習",
    "app-tab-cards": "カード",
    "app-tab-history": "履歴",
    "app-tab-settings": "設定",
    "app-theme-toggle-dark": "ダークテーマに切り替え",
    "app-theme-toggle-light": "ライトテーマに切り替え",
  },
  "zh-CN": {
    "app-tab-practice": "练习",
    "app-tab-review": "复习",
    "app-tab-cards": "卡片",
    "app-tab-history": "历史",
    "app-tab-settings": "设置",
    "app-theme-toggle-dark": "切换到深色主题",
    "app-theme-toggle-light": "切换到浅色主题",
  },
  "zh-TW": {
    "app-tab-practice": "練習",
    "app-tab-review": "複習",
    "app-tab-cards": "卡片",
    "app-tab-history": "歷史",
    "app-tab-settings": "設定",
    "app-theme-toggle-dark": "切換為深色主題",
    "app-theme-toggle-light": "切換為淺色主題",
  },
} satisfies MessageBundle;
