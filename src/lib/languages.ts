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

/** What a card's "reading" field should mean for a given target language —
 * pinyin for Chinese, IPA for English, romanization for other non-Latin
 * scripts, plain "how do I say this" otherwise. Drives both the card-form
 * field label/placeholder (CardsView) and the English instruction fragment
 * spliced into the LLM card-extraction prompt (lib/llm.ts). */
export interface ReadingSpec {
  /** Japanese UI label for the card form's reading field (rendered as `${label}(任意)`). */
  label: string;
  /** Placeholder example for the manual input, "" if none. */
  placeholder: string;
  /** English fragment inserted into the LLM card-extraction prompt after `"reading" (...)`. */
  llmInstruction: string;
}

const DEFAULT_READING_SPEC: ReadingSpec = {
  label: "読み方",
  placeholder: "",
  llmInstruction: "pronunciation help if useful for the target language, else an empty string",
};

const readingSpecs: Record<string, ReadingSpec> = {
  "Chinese (Simplified)": {
    label: "ピンイン",
    placeholder: "nǐ hǎo",
    llmInstruction: 'Hanyu Pinyin with tone marks, e.g. "nǐ hǎo"',
  },
  "Chinese (Traditional)": {
    label: "ピンイン",
    placeholder: "nǐ hǎo",
    llmInstruction: 'Hanyu Pinyin with tone marks, e.g. "nǐ hǎo"',
  },
  English: {
    label: "発音記号",
    placeholder: "/ˈwɔːtər/",
    llmInstruction: 'the IPA transcription enclosed in slashes, e.g. "/ˈwɔːtər/"',
  },
  Japanese: {
    label: "読み仮名",
    placeholder: "ひらがな",
    llmInstruction: "the reading in hiragana",
  },
  Korean: {
    label: "ローマ字読み",
    placeholder: "annyeonghaseyo",
    llmInstruction: "Revised Romanization of Korean",
  },
  Russian: {
    label: "ローマ字読み",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
  Arabic: {
    label: "ローマ字読み",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
  Hindi: {
    label: "ローマ字読み",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
  Thai: {
    label: "ローマ字読み",
    placeholder: "",
    llmInstruction: "a Latin-alphabet romanization",
  },
};

/** Reading-field spec for a target language, falling back to a generic
 * "読み方" for languages without a script-specific convention (including "" or
 * an unknown user-typed language). */
export function readingSpec(language: string): ReadingSpec {
  return readingSpecs[language] ?? DEFAULT_READING_SPEC;
}
