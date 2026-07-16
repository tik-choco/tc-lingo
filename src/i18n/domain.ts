import type { MessageBundle } from "./types";

// Domain-layer strings: card reading-field labels (lib/languages.ts) and
// user-facing error messages thrown by lib/llm.ts / lib/parse.ts. Keys are
// prefixed "reading-" / "error-".
export const domainMessages = {
  en: {
    "reading-label-default": "Reading",
    "reading-label-pinyin": "Pinyin",
    "reading-label-ipa": "IPA",
    "reading-label-kana": "Kana reading",
    "reading-label-romanization": "Romanization",
    "error-empty-response": "The AI returned no response.",
    "error-empty-test-response": "The response was empty.",
    "error-parse-json": "Could not parse the AI response as JSON. Please try again.",
    "error-missing-correction": "The AI response did not include a corrected version.",
    "error-missing-topic": "The AI response did not include a topic.",
  },
  ja: {
    "reading-label-default": "読み方",
    "reading-label-pinyin": "ピンイン",
    "reading-label-ipa": "発音記号",
    "reading-label-kana": "読み仮名",
    "reading-label-romanization": "ローマ字読み",
    "error-empty-response": "AIから応答がありませんでした。",
    "error-empty-test-response": "応答が空でした。",
    "error-parse-json": "AIの応答をJSONとして解析できませんでした。もう一度試してください。",
    "error-missing-correction": "AIの応答に修正版が含まれていませんでした。",
    "error-missing-topic": "AIの応答にトピックが含まれていませんでした。",
  },
  "zh-CN": {
    "reading-label-default": "读音",
    "reading-label-pinyin": "拼音",
    "reading-label-ipa": "音标",
    "reading-label-kana": "假名读音",
    "reading-label-romanization": "罗马字转写",
    "error-empty-response": "AI 没有返回任何回应。",
    "error-empty-test-response": "回应为空。",
    "error-parse-json": "无法将 AI 的回应解析为 JSON。请重试。",
    "error-missing-correction": "AI 的回应中不包含修正版。",
    "error-missing-topic": "AI 的回应中不包含话题。",
  },
  "zh-TW": {
    "reading-label-default": "讀音",
    "reading-label-pinyin": "拼音",
    "reading-label-ipa": "音標",
    "reading-label-kana": "假名讀音",
    "reading-label-romanization": "羅馬字轉寫",
    "error-empty-response": "AI 沒有返回任何回應。",
    "error-empty-test-response": "回應為空。",
    "error-parse-json": "無法將 AI 的回應解析為 JSON。請重試。",
    "error-missing-correction": "AI 的回應中不包含修正版。",
    "error-missing-topic": "AI 的回應中不包含話題。",
  },
} satisfies MessageBundle;
