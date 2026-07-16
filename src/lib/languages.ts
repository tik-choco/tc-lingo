// Canonical language options plus UI-locale-aware display labels. The
// canonical English names are what get passed straight into LLM prompts
// (lib/llm.ts) — this file only changes how languages are *picked* and
// *displayed*. Display names follow the active UI language (see i18n/index.ts;
// LLM-overlay UI languages read as "en" and show the canonical names).
// Name maps mirror tc-translate's constants.ts.
import { getUiLanguage, t } from "../i18n";

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

const languageChineseSimplifiedNames: Record<string, string> = {
  English: "英语",
  Japanese: "日语",
  Korean: "韩语",
  "Chinese (Simplified)": "简体中文",
  "Chinese (Traditional)": "繁体中文",
  Spanish: "西班牙语",
  French: "法语",
  German: "德语",
  Portuguese: "葡萄牙语",
  Italian: "意大利语",
  Russian: "俄语",
  Arabic: "阿拉伯语",
  Hindi: "印地语",
  Indonesian: "印度尼西亚语",
  Vietnamese: "越南语",
  Thai: "泰语",
  Turkish: "土耳其语",
  Dutch: "荷兰语",
  Polish: "波兰语",
  Swedish: "瑞典语",
};

const languageChineseTraditionalNames: Record<string, string> = {
  English: "英語",
  Japanese: "日語",
  Korean: "韓語",
  "Chinese (Simplified)": "簡體中文",
  "Chinese (Traditional)": "繁體中文",
  Spanish: "西班牙語",
  French: "法語",
  German: "德語",
  Portuguese: "葡萄牙語",
  Italian: "義大利語",
  Russian: "俄語",
  Arabic: "阿拉伯語",
  Hindi: "印地語",
  Indonesian: "印尼語",
  Vietnamese: "越南語",
  Thai: "泰語",
  Turkish: "土耳其語",
  Dutch: "荷蘭語",
  Polish: "波蘭語",
  Swedish: "瑞典語",
};

/** Each language's name in its own script, appended to picker labels so a
 * learner can spot their language regardless of the current UI language. */
export const languageNativeNames: Record<string, string> = {
  English: "English",
  Japanese: "日本語",
  Korean: "한국어",
  "Chinese (Simplified)": "简体中文",
  "Chinese (Traditional)": "繁體中文",
  Spanish: "Español",
  French: "Français",
  German: "Deutsch",
  Portuguese: "Português",
  Italian: "Italiano",
  Russian: "Русский",
  Arabic: "العربية",
  Hindi: "हिन्दी",
  Indonesian: "Bahasa Indonesia",
  Vietnamese: "Tiếng Việt",
  Thai: "ไทย",
  Turkish: "Türkçe",
  Dutch: "Nederlands",
  Polish: "Polski",
  Swedish: "Svenska",
};

/** Display label for a language in the active UI language. Falls back to the
 * canonical name so a value the user typed before this list existed (or a
 * language outside the curated list) never disappears from the UI. */
export function languageDisplayName(language: string): string {
  if (!language) return "";
  const uiLanguage = getUiLanguage();
  if (uiLanguage === "ja") return languageJapaneseNames[language] ?? language;
  if (uiLanguage === "zh-CN") return languageChineseSimplifiedNames[language] ?? language;
  if (uiLanguage === "zh-TW") return languageChineseTraditionalNames[language] ?? language;
  return language;
}

/** Display name plus the language's own-script name when they differ,
 * e.g. "スペイン語（Español）" — for language pickers. */
export function languageOptionLabel(language: string): string {
  const name = languageDisplayName(language);
  const native = languageNativeNames[language];
  return native && native !== name ? `${name}（${native}）` : name;
}

/** What a card's "reading" field should mean for a given target language —
 * pinyin for Chinese, IPA for English, romanization for other non-Latin
 * scripts, plain "how do I say this" otherwise. Drives both the card-form
 * field label/placeholder (CardsView) and the English instruction fragment
 * spliced into the LLM card-extraction prompt (lib/llm.ts). */
export interface ReadingSpec {
  /** UI label for the card form's reading field, already localized to the
   * active UI language (message keys live in i18n/domain.ts). */
  label: string;
  /** Placeholder example for the manual input, "" if none. */
  placeholder: string;
  /** English fragment inserted into the LLM card-extraction prompt after `"reading" (...)`. */
  llmInstruction: string;
}

interface ReadingSpecDef {
  labelKey: string;
  placeholder: string;
  llmInstruction: string;
}

const DEFAULT_READING_SPEC: ReadingSpecDef = {
  labelKey: "reading-label-default",
  placeholder: "",
  llmInstruction: "pronunciation help if useful for the target language, else an empty string",
};

const readingSpecDefs: Record<string, ReadingSpecDef> = {
  "Chinese (Simplified)": {
    labelKey: "reading-label-pinyin",
    placeholder: "nǐ hǎo",
    llmInstruction: 'Hanyu Pinyin with tone marks, e.g. "nǐ hǎo"',
  },
  "Chinese (Traditional)": {
    labelKey: "reading-label-pinyin",
    placeholder: "nǐ hǎo",
    llmInstruction: 'Hanyu Pinyin with tone marks, e.g. "nǐ hǎo"',
  },
  English: {
    labelKey: "reading-label-ipa",
    placeholder: "/ˈwɔːtər/",
    llmInstruction: 'the IPA transcription enclosed in slashes, e.g. "/ˈwɔːtər/"',
  },
  Japanese: {
    labelKey: "reading-label-kana",
    placeholder: "ひらがな",
    llmInstruction: "the reading in hiragana",
  },
  Korean: {
    labelKey: "reading-label-romanization",
    placeholder: "annyeonghaseyo",
    llmInstruction: "Revised Romanization of Korean",
  },
  Russian: {
    labelKey: "reading-label-romanization",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
  Arabic: {
    labelKey: "reading-label-romanization",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
  Hindi: {
    labelKey: "reading-label-romanization",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
  Thai: {
    labelKey: "reading-label-romanization",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
};

/** Reading-field spec for a target language, falling back to a generic
 * "reading" label for languages without a script-specific convention
 * (including "" or an unknown user-typed language). The label is resolved
 * against the active UI language at call time. */
export function readingSpec(language: string): ReadingSpec {
  const def = readingSpecDefs[language] ?? DEFAULT_READING_SPEC;
  return { label: t(def.labelKey), placeholder: def.placeholder, llmInstruction: def.llmInstruction };
}
