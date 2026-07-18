// Session CRUD for the 会話 (Talk) tab, plus the two LLM calls that drive it:
// generating an opening scenario (requestConversationStart) and continuing +
// correcting the dialogue turn by turn (requestConversationReply). This is
// the やり取り (interaction) leg of CLAUDE.md's core loop — meaningful,
// multi-turn dialogue with corrective feedback woven in, as opposed to 練習's
// one-shot topic writing. Persistence key: tc-lingo:conversations-v1, capped
// at the 20 newest sessions (a learner's dialogue history is meant for quick
// re-review, not an unbounded archive — same rationale as other domain
// modules' bounded lists).
import type { ConversationRole, ConversationSession, ConversationTurn } from "../types";
import { loadJson, newId, saveJson, subscribeStorage } from "./storage";
import { chatJson } from "./llm";
import type { LlmConnection } from "./llmConnection";
import { levelInstruction } from "./level";
import { extractJson } from "./parse";
import { t } from "../i18n";

const STORAGE_NAME = "conversations-v1";
const MAX_SESSIONS = 20;

function isConversationRole(value: unknown): value is ConversationRole {
  return value === "assistant" || value === "learner";
}

function isConversationTurn(value: unknown): value is ConversationTurn {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    isConversationRole(r.role) &&
    typeof r.text === "string" &&
    typeof r.corrected === "string" &&
    typeof r.reasons === "string"
  );
}

function isConversationSession(value: unknown): value is ConversationSession {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.language === "string" &&
    typeof r.title === "string" &&
    typeof r.scenario === "string" &&
    Array.isArray(r.turns) &&
    r.turns.every(isConversationTurn) &&
    typeof r.createdAt === "string" &&
    typeof r.endedAt === "string"
  );
}

/** `language`, when given, also matches sessions saved with "" (unassigned,
 * predating multi-language support) so they aren't orphaned out of view —
 * same convention as cards.ts/topics.ts. Malformed entries (and any
 * individually malformed turn) are dropped rather than throwing. */
export function loadConversations(language?: string): ConversationSession[] {
  const raw = loadJson<unknown[]>(STORAGE_NAME, []);
  const sessions = Array.isArray(raw) ? raw.filter(isConversationSession) : [];
  return language ? sessions.filter((s) => s.language === language || s.language === "") : sessions;
}

function saveConversations(sessions: ConversationSession[]): void {
  saveJson(STORAGE_NAME, sessions);
}

export function subscribeConversations(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export interface NewConversationInput {
  language: string;
  title: string;
  scenario: string;
  /** The assistant's opening turn (and any further seed turns), so a fresh
   * session is created already showing its scenario-opening line. */
  turns?: ConversationTurn[];
}

export function addConversation(input: NewConversationInput): ConversationSession {
  const session: ConversationSession = {
    id: newId(),
    language: input.language,
    title: input.title.trim(),
    scenario: input.scenario.trim(),
    turns: input.turns ?? [],
    createdAt: new Date().toISOString(),
    endedAt: "",
  };
  // Newest first, capped at MAX_SESSIONS — oldest sessions fall off instead
  // of growing localStorage unboundedly.
  saveConversations([session, ...loadConversations()].slice(0, MAX_SESSIONS));
  return session;
}

/** Replaces the session with the given id by shallow-merging `patch` — same
 * "replace by id" shape as topics.ts's updateAttempt. */
export function updateConversation(id: string, patch: Partial<Omit<ConversationSession, "id">>): void {
  const sessions = loadConversations().map((s) => (s.id === id ? { ...s, ...patch } : s));
  saveConversations(sessions);
}

export function deleteConversation(id: string): void {
  saveConversations(loadConversations().filter((s) => s.id !== id));
}

/** Builds one turn with a fresh id — callers append it to a session's
 * `turns` and persist via updateConversation/addConversation. */
export function newTurn(input: { role: ConversationRole; text: string; corrected?: string; reasons?: string }): ConversationTurn {
  return {
    id: newId(),
    role: input.role,
    text: input.text,
    corrected: input.corrected ?? "",
    reasons: input.reasons ?? "",
  };
}

export interface ConversationStartResult {
  title: string;
  scenario: string;
  opening: string;
}

function parseConversationStart(content: string): ConversationStartResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const scenario = typeof parsed.scenario === "string" ? parsed.scenario : "";
  const opening = typeof parsed.opening === "string" ? parsed.opening : "";
  if (!title || !opening) throw new Error(t("talk-error-missing-start"));
  return { title, scenario, opening };
}

/** Kicks off a fresh 会話 session: the AI invents one concrete everyday
 * scenario and writes an opening line the learner can reply to. Both prompts
 * fold in lib/level.ts's `levelInstruction` (a "" no-op until enough samples
 * exist) so the AI partner pitches its language at the learner's estimated
 * CEFR level. */
export async function requestConversationStart(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  /** Recent session titles, so the AI avoids repeating the same scenario. */
  recentTitles: string[];
}): Promise<ConversationStartResult> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's conversation partner for a learner of ${params.targetLanguage} (native language: ${params.nativeLanguage}). Invent one concrete, everyday scenario for a short dialogue (for example: ordering at a café, asking for directions, small talk about the weekend) — avoid repeating any scenario in recentTitles. Write an opening line in ${params.targetLanguage} that invites the learner to reply, using simple, natural language, 1-2 short sentences. Return only JSON with exactly these keys: "title" (a short scenario label in ${params.nativeLanguage}), "scenario" (a one-sentence scenario instruction in ${params.nativeLanguage}, describing the setting/role you will play, for you to keep following in later turns), "opening" (your opening line in ${params.targetLanguage}).${levelInstruction(params.targetLanguage)}`,
    { recentTitles: params.recentTitles },
  );
  return parseConversationStart(content);
}

export interface ConversationReplyResult {
  reply: string;
  corrected: string;
  reasons: string;
}

function parseConversationReply(content: string): ConversationReplyResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const reply = typeof parsed.reply === "string" ? parsed.reply : "";
  const corrected = typeof parsed.corrected === "string" ? parsed.corrected : "";
  const reasons = typeof parsed.reasons === "string" ? parsed.reasons : "";
  if (!reply) throw new Error(t("talk-error-missing-reply"));
  return { reply, corrected, reasons };
}

/** Continues an in-progress 会話 session: the AI replies in character (per
 * `scenario`), always inviting the learner to keep talking, and separately
 * corrects the learner's latest message (empty corrected/reasons when it was
 * already natural). Prior turns are stripped down to `{role, text}` — the
 * learner's own past corrections aren't fed back in, only the raw dialogue
 * so far. */
export async function requestConversationReply(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  scenario: string;
  turns: ConversationTurn[];
  learnerText: string;
}): Promise<ConversationReplyResult> {
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's conversation partner for a learner of ${params.targetLanguage} (native language: ${params.nativeLanguage}), continuing a scripted-scenario dialogue. Follow the scenario instruction (scenario) and continue the conversation naturally in ${params.targetLanguage} — simple, natural language, 1-2 short sentences, always ending in a way that invites the learner to keep talking (a question or a prompt). Separately, correct the learner's latest message (learnerText): if it has grammar, word-choice, or naturalness issues, return the corrected version in ${params.targetLanguage} plus concise reasons in ${params.nativeLanguage}; if it is already natural, return empty strings for both corrected and reasons. Return only JSON with exactly these keys: "reply" (your next line in ${params.targetLanguage}), "corrected" (corrected ${params.targetLanguage} text, or "" if nothing to correct), "reasons" (explanation in ${params.nativeLanguage}, or "" if nothing to correct).${levelInstruction(params.targetLanguage)}`,
    {
      scenario: params.scenario,
      turns: params.turns.map((turn) => ({ role: turn.role, text: turn.text })),
      learnerText: params.learnerText,
    },
  );
  return parseConversationReply(content);
}
