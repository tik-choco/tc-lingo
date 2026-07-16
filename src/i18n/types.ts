// UI-language plumbing types. Mirrors tc-translate's src/i18n/types.ts:
// four hand-written dictionaries; every other native language gets an
// LLM-translated overlay generated at runtime (see i18n/index.ts).
export type UiLanguage = "en" | "ja" | "zh-CN" | "zh-TW";

export type MessageTable = Record<string, string>;

/** One area's messages: same keys in every language, en is the fallback. */
export interface MessageBundle {
  en: MessageTable;
  ja: MessageTable;
  "zh-CN": MessageTable;
  "zh-TW": MessageTable;
}
