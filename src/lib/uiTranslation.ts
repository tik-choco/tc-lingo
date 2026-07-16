// Runtime UI localization for native languages without a hand-written
// dictionary (see i18n/index.ts): the English source strings are translated
// once by the configured LLM and cached. Ported from tc-translate's
// lib/uiTranslation.ts, using this app's resolved LlmConnection (direct API
// preset or AI Network room — see lib/llmConnection.ts).
import { streamChatCompletion } from "@tik-choco/mistai";
import type { ChatMessage } from "@tik-choco/mistai";
import type { MessageTable } from "../i18n/types";
import type { LlmConnection } from "./llmConnection";
import { requestNetworkChat } from "./network";

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in response.");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function placeholderSignature(value: string): string {
  return [...value.matchAll(/\{[A-Za-z0-9]+\}/g)]
    .map((match) => match[0])
    .sort()
    .join(",");
}

/**
 * Translate the app's English UI strings into `language` with the configured
 * LLM. Keys the model drops, leaves empty, or whose `{placeholder}` tokens it
 * mangles fall back to the English source, so a partial answer still yields a
 * usable table.
 */
export async function translateUiMessages(params: {
  connection: LlmConnection;
  language: string;
  messages: MessageTable;
}): Promise<MessageTable> {
  const { connection, language, messages } = params;
  const chatMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You localize the user interface of a language-learning app. Translate every value of the JSON object the user sends from English into ${language}. ` +
        "Respond with ONLY a valid JSON object containing exactly the same keys. " +
        "Keep placeholder tokens such as {count} or {language} exactly as they are. " +
        "Leave technical terms like API, Base URL, and product/model names untranslated. " +
        "Keep translations concise; they are UI labels and short hints.",
    },
    { role: "user", content: JSON.stringify(messages) },
  ];
  const content =
    connection.kind === "network"
      ? // See lib/llm.ts's chatJson for why no model is passed here.
        await requestNetworkChat(connection.roomId, chatMessages, undefined)
      : await streamChatCompletion(
          {
            baseUrl: connection.target.baseUrl.trim().replace(/\/+$/, ""),
            apiKey: connection.target.apiKey,
            model: connection.target.model,
            temperature: connection.target.temperature,
            reasoningEffort: connection.target.reasoningEffort,
          },
          chatMessages,
        );

  const parsed = extractJsonObject(content);
  const result: MessageTable = {};
  for (const [key, source] of Object.entries(messages)) {
    const translated = parsed[key];
    result[key] =
      typeof translated === "string" && translated.trim() && placeholderSignature(translated) === placeholderSignature(source)
        ? translated
        : source;
  }
  return result;
}
