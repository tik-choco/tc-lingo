import type { MessageBundle } from "./types";

export const grammarMessages = {
  en: {
    "grammar-explain-button": "Explain grammar",
    "grammar-collapse-button": "Collapse",
    "grammar-loading": "Generating explanation…",
    "grammar-retry-button": "Retry",
    "grammar-empty-state": "Nothing notable to explain in this sentence.",
    "grammar-example-label": "Example",
    "grammar-error-generic": "Couldn't generate a grammar explanation.",
    "grammar-error-parse": "Couldn't read the grammar explanation.",
  },
  ja: {
    "grammar-explain-button": "文法を解説",
    "grammar-collapse-button": "閉じる",
    "grammar-loading": "解説を生成中…",
    "grammar-retry-button": "再試行",
    "grammar-empty-state": "この文には特筆すべき文法ポイントはありません。",
    "grammar-example-label": "例",
    "grammar-error-generic": "文法解説を生成できませんでした。",
    "grammar-error-parse": "文法解説の内容を読み取れませんでした。",
  },
  "zh-CN": {
    "grammar-explain-button": "讲解语法",
    "grammar-collapse-button": "收起",
    "grammar-loading": "正在生成讲解…",
    "grammar-retry-button": "重试",
    "grammar-empty-state": "这句话没有特别需要讲解的语法点。",
    "grammar-example-label": "例句",
    "grammar-error-generic": "无法生成语法讲解。",
    "grammar-error-parse": "无法读取语法讲解内容。",
  },
  "zh-TW": {
    "grammar-explain-button": "講解語法",
    "grammar-collapse-button": "收起",
    "grammar-loading": "正在生成講解…",
    "grammar-retry-button": "重試",
    "grammar-empty-state": "這句話沒有特別需要講解的語法點。",
    "grammar-example-label": "例句",
    "grammar-error-generic": "無法生成語法講解。",
    "grammar-error-parse": "無法讀取語法講解內容。",
  },
} satisfies MessageBundle;
