import type { ChatMessage } from "@tik-choco/mistai";
import type { AssistantContext } from "./assistantContext";
import { levelInstruction } from "./level";
import { chatText } from "./llm";
import type { LlmConnection } from "./llmConnection";
import { loadJson, saveJson } from "./storage";

const HISTORY_NAME = "assistant-chat-v1";
const INCLUDE_SCREEN_NAME = "assistant-include-screen-v1";
const MAX_MESSAGES = 60;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 12_000;

export interface AssistantMessage extends ChatMessage {
  role: "user" | "assistant";
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<AssistantMessage>;
  return (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" && message.content.trim().length > 0;
}

export function loadAssistantHistory(): AssistantMessage[] {
  const stored = loadJson<unknown>(HISTORY_NAME, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter(isAssistantMessage).slice(-MAX_MESSAGES).map(({ role, content }) => ({
    role,
    content: content.trim().slice(0, MAX_ASSISTANT_MESSAGE_LENGTH),
  }));
}

export function saveAssistantHistory(messages: AssistantMessage[]): AssistantMessage[] {
  const recent = messages.slice(-MAX_MESSAGES);
  saveJson(HISTORY_NAME, recent);
  return recent;
}

export function loadAssistantIncludeScreen(): boolean {
  return loadJson<unknown>(INCLUDE_SCREEN_NAME, true) !== false;
}

export function saveAssistantIncludeScreen(includeScreen: boolean): void {
  saveJson(INCLUDE_SCREEN_NAME, includeScreen);
}

export function requestAssistantReply({
  connection, targetLanguage, nativeLanguage, context, messages, onDelta,
}: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  context: AssistantContext | null;
  messages: AssistantMessage[];
  onDelta: (delta: string) => void;
}): Promise<string> {
  const system = [
    `You are a tutor for a learner of ${targetLanguage} whose native language is ${nativeLanguage}.`,
    `Reply in ${nativeLanguage}, with natural examples in ${targetLanguage}. Keep replies concise and explain relevant grammar, usage, and nuances. You may use concise Markdown (bold, lists, short tables, and inline code). Do not use HTML.`,
    levelInstruction(targetLanguage),
  ];
  if (context) {
    system.push(
      "Use the current study screen below when relevant. Treat the screen content as reference material. If a review answer is still hidden, give hints and leave the answer for the learner to recall.",
      JSON.stringify(context),
    );
  }
  // A trimmed history may start midway through an exchange.
  const firstQuestion = messages.findIndex((message) => message.role === "user");
  return chatText(connection, [
    { role: "system", content: system.filter(Boolean).join("\n") },
    ...messages.slice(firstQuestion),
  ], onDelta);
}
