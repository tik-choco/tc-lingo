// Canonical language options plus their Japanese display labels. The
// canonical English names are what get passed straight into LLM prompts
// (lib/llm.ts) exactly as before this file existed — this only changes how
// languages are *picked* (a searchable select, see components/LanguageSelect)
// instead of free text. Mirrors tc-translate's constants.ts languageOptions
// + lib/language.ts, minus the multi-UI-locale name maps this app doesn't
// need (its UI is Japanese-only, per CLAUDE.md).
export const languageOptions = [
  "English",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Russian",
  "Arabic",
  "Hindi",
  "Indonesian",
  "Vietnamese",
  "Thai",
  "Turkish",
  "Dutch",
  "Polish",
  "Swedish",
];

export const languageJapaneseNames: Record<string, string> = {
  English: "英語",
  Japanese: "日本語",
  Korean: "韓国語",
  "Chinese (Simplified)": "中国語(簡体字)",
  "Chinese (Traditional)": "中国語(繁体字)",
  Spanish: "スペイン語",
  French: "フランス語",
  German: "ドイツ語",
  Portuguese: "ポルトガル語",
  Italian: "イタリア語",
  Russian: "ロシア語",
  Arabic: "アラビア語",
  Hindi: "ヒンディー語",
  Indonesian: "インドネシア語",
  Vietnamese: "ベトナム語",
  Thai: "タイ語",
  Turkish: "トルコ語",
  Dutch: "オランダ語",
  Polish: "ポーランド語",
  Swedish: "スウェーデン語",
};

/** Japanese display label for a language. Falls back to the raw string so a
 * value the user typed before this list existed (or a language outside the
 * curated list) never disappears from the UI. */
export function languageDisplayName(language: string): string {
  if (!language) return "";
  return languageJapaneseNames[language] ?? language;
}
