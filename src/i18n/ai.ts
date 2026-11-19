import type { MessageBundle } from "./types";

export const aiMessages = {
  "en": {
    "ai-settings": "AI settings",
    "ai-task-decision": "System One decision model",
    "ai-decision-disabled": "Disabled",
    "ai-decision-hint": "Choose a System One model, for example one served at Ollama’s /v1/systemone or shared by a room provider.",
    "ai-decision-test": "Test decision model",
    "ai-decision-test-testing": "Testing…",
    "ai-decision-test-ok": "The decision model responded successfully.",
    "ai-decision-test-error": "Couldn’t get a valid response from the decision model. Check the model and endpoint.",
    "ai-task-group-correction": "Correction & conversation",
    "ai-task-group-correction-hint": "Practice feedback, review, and conversation.",
    "ai-task-group-generation": "Content generation",
    "ai-task-group-generation-hint": "Topic suggestions, cards, reading, grammar, and UI translation.",
    "ai-task-group-card-organize": "Similar-card detection model",
    "ai-task-group-card-organize-hint": "Uses embeddings to find similar cards."
  },
  "ja": {
    "ai-settings": "AI設定",
    "ai-task-decision": "System One 判定モデル",
    "ai-decision-disabled": "無効",
    "ai-decision-hint": "Ollama の /v1/systemone で使えるモデルや、ルームで共有されている System One 対応モデルを選んでください。",
    "ai-decision-test": "判定モデルをテスト",
    "ai-decision-test-testing": "テスト中…",
    "ai-decision-test-ok": "判定モデルから正常な応答がありました。",
    "ai-decision-test-error": "判定モデルから有効な応答が得られませんでした。モデルと接続先を確認してください。",
    "ai-task-group-correction": "添削・会話",
    "ai-task-group-correction-hint": "練習の添削、復習、会話に使います。",
    "ai-task-group-generation": "生成",
    "ai-task-group-generation-hint": "トピック提案、カード、読解、文法、UI翻訳に使います。",
    "ai-task-group-card-organize": "類似カード検出モデル",
    "ai-task-group-card-organize-hint": "埋め込みを使って類似カードを検出します。"
  },
  "zh-CN": {
    "ai-settings": "AI设置",
    "ai-task-decision": "System One 判定模型",
    "ai-decision-disabled": "已禁用",
    "ai-decision-hint": "请选择支持 System One 的模型，例如 Ollama 的 /v1/systemone 所提供的模型，或房间中共享的模型。",
    "ai-decision-test": "测试判定模型",
    "ai-decision-test-testing": "正在测试…",
    "ai-decision-test-ok": "判定模型已正常响应。",
    "ai-decision-test-error": "未收到判定模型的有效响应。请检查模型和端点。",
    "ai-task-group-correction": "纠错与对话",
    "ai-task-group-correction-hint": "用于练习纠错、复习和对话。",
    "ai-task-group-generation": "内容生成",
    "ai-task-group-generation-hint": "用于话题建议、卡片、阅读、语法和界面翻译。",
    "ai-task-group-card-organize": "相似卡片检测模型",
    "ai-task-group-card-organize-hint": "使用向量嵌入查找相似卡片。"
  },
  "zh-TW": {
    "ai-settings": "AI設定",
    "ai-task-decision": "System One 判定模型",
    "ai-decision-disabled": "已停用",
    "ai-decision-hint": "請選擇支援 System One 的模型，例如 Ollama 的 /v1/systemone 所提供的模型，或房間中共用的模型。",
    "ai-decision-test": "測試判定模型",
    "ai-decision-test-testing": "測試中…",
    "ai-decision-test-ok": "判定模型已正常回應。",
    "ai-decision-test-error": "未收到判定模型的有效回應。請檢查模型和端點。",
    "ai-task-group-correction": "訂正與對話",
    "ai-task-group-correction-hint": "用於練習訂正、複習和對話。",
    "ai-task-group-generation": "內容生成",
    "ai-task-group-generation-hint": "用於話題建議、卡片、閱讀、文法和介面翻譯。",
    "ai-task-group-card-organize": "相似卡片偵測模型",
    "ai-task-group-card-organize-hint": "使用向量嵌入尋找相似卡片。"
  }
} satisfies MessageBundle;
