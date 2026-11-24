// Session CRUD for the 会話 (Talk) tab, plus the two LLM calls that drive it:
// generating an opening scenario (requestConversationStart) and continuing +
// correcting the dialogue turn by turn (requestConversationReply). This is
// the やり取り (interaction) leg of CLAUDE.md's core loop — meaningful,
// multi-turn dialogue with corrective feedback woven in, as opposed to 練習's
// one-shot topic writing. Persistence key: tc-lingo:conversations-v1, capped
// at the 20 newest sessions (a learner's dialogue history is meant for quick
// re-review, not an unbounded archive — same rationale as other domain
// modules' bounded lists).
import type { ConversationMode, ConversationRole, ConversationSession, ConversationTurn, InquiryFact, InquiryUnderstanding } from "../types";
import { loadDomainJson, newId, nextUpdatedAt, saveJson, subscribeStorage, type StorageWriteOptions } from "./storage";
import { persistDeletions } from "./sync/tombstones";
import { chatJson } from "./llm";
import type { LlmConnection } from "./llmConnection";
import { levelInstruction } from "./level";
import { readingAid } from "./languages";
import { extractJson } from "./parse";
import { t } from "../i18n";

const STORAGE_NAME = "conversations-v1";

/** Shared feedback rubric for the Talk tab's free and inquiry modes. */
export const APPROPRIATENESS_REVIEW =
  "Check grammar, word choice, naturalness, and whether the politeness and register fit the scenario's setting and the relationship between the speakers (e.g. customer and staff, strangers, friends, or a tenant and landlord). If there are errors, including wording that would come across as plainly rude, overly demanding, or otherwise clearly inappropriate, give the best version for the situation in \"corrected\" and explain the issue in \"reasons\", including how the wording would come across for a register error. Otherwise, if there is a clearly better way to phrase it here, give it in \"suggestion\" and explain the improvement in \"suggestionReason\". Fill in only the fields for the chosen correction or suggestion. If neither applies, leave all correction and suggestion fields empty.";

export function suggestionKeys(targetLanguage: string, nativeLanguage: string, readingInstruction?: string): string[] {
  const keys = [
    `"suggestion" (a better ${targetLanguage} way to say learnerText without changing its meaning, more natural or better suited to this situation's politeness/register, only if there are no errors to correct and a native speaker would clearly phrase it differently here. Use "" whenever "corrected" is non-empty or the original is already natural and appropriate. Do not suggest mere synonyms or stylistic trivia.)`,
  ];
  if (readingInstruction) keys.push(`"suggestionReading" (the reading of "suggestion", as ${readingInstruction}, or "" if "suggestion" is "")`);
  keys.push(
    `"suggestionTranslation" (translation of "suggestion" in ${nativeLanguage}, or "" if "suggestion" is "")`,
    `"suggestionReason" (concise explanation in ${nativeLanguage} of why the suggestion fits better, e.g. it sounds more polite when speaking to staff, or "" if "suggestion" is "")`,
  );
  return keys;
}

const MAX_SESSIONS = 20;

function isConversationRole(value: unknown): value is ConversationRole {
  return value === "assistant" || value === "learner";
}

function isInquiryUnderstanding(value: unknown): value is InquiryUnderstanding {
  return value === "" || value === "full" || value === "partial" || value === "none";
}

function isInquiryFact(value: unknown): value is InquiryFact {
  if (value === null || typeof value !== "object") return false;
  const { id, label, detail } = value as Record<string, unknown>;
  return typeof id === "string" && !!id.trim() && typeof label === "string" && !!label.trim() &&
    typeof detail === "string" && !!detail.trim();
}

/** Fields added after the initial format are optional when loading old data. */
function isConversationTurn(value: unknown): value is ConversationTurn {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    isConversationRole(r.role) &&
    typeof r.text === "string" &&
    (r.reading === undefined || typeof r.reading === "string") &&
    (r.translation === undefined || typeof r.translation === "string") &&
    typeof r.corrected === "string" &&
    (r.correctedReading === undefined || typeof r.correctedReading === "string") &&
    (r.correctedTranslation === undefined || typeof r.correctedTranslation === "string") &&
    typeof r.reasons === "string" &&
    (r.suggestion === undefined || typeof r.suggestion === "string") &&
    (r.suggestionReading === undefined || typeof r.suggestionReading === "string") &&
    (r.suggestionTranslation === undefined || typeof r.suggestionTranslation === "string") &&
    (r.suggestionReason === undefined || typeof r.suggestionReason === "string") &&
    (r.understanding === undefined || isInquiryUnderstanding(r.understanding)) &&
    (r.unclearReason === undefined || typeof r.unclearReason === "string") &&
    (r.revealedFactIds === undefined || (Array.isArray(r.revealedFactIds) && r.revealedFactIds.every((id) => typeof id === "string")))
  );
}

/** Exported so lib/sync/snapshot.ts can validate remote sessions with the
 * exact same rules used to load local ones. `updatedAt` is optional here to
 * accept sessions saved before the sync feature existed — see
 * sanitizeConversations. */
export function isConversationSession(value: unknown): value is ConversationSession {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.language === "string" &&
    typeof r.title === "string" &&
    typeof r.scenario === "string" &&
    (r.mode === undefined || typeof r.mode === "string") &&
    (r.mission === undefined || typeof r.mission === "string") &&
    (r.facts === undefined || Array.isArray(r.facts)) &&
    (r.retryOfId === undefined || typeof r.retryOfId === "string") &&
    Array.isArray(r.turns) &&
    r.turns.every(isConversationTurn) &&
    typeof r.createdAt === "string" &&
    typeof r.endedAt === "string" &&
    (r.updatedAt === undefined || typeof r.updatedAt === "string")
  );
}

/** Normalizes local and remote sessions without changing their revisions.
 * Drops malformed sessions (including those with malformed turns) and filters
 * invalid fact entries from otherwise valid sessions. */
export function sanitizeConversations(raw: unknown): ConversationSession[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isConversationSession).map((s) => ({
    ...s,
    mode: s.mode === "inquiry" ? "inquiry" : "free",
    mission: s.mission ?? "",
    facts: s.facts?.filter(isInquiryFact).map(({ id, label, detail }) => ({ id, label, detail })) ?? [],
    retryOfId: s.retryOfId ?? "",
    turns: s.turns.map((turn) => ({
      ...turn,
      reading: turn.reading ?? "",
      translation: turn.translation ?? "",
      correctedReading: turn.correctedReading ?? "",
      correctedTranslation: turn.correctedTranslation ?? "",
      suggestion: turn.suggestion ?? "",
      suggestionReading: turn.suggestionReading ?? "",
      suggestionTranslation: turn.suggestionTranslation ?? "",
      suggestionReason: turn.suggestionReason ?? "",
      understanding: turn.understanding ?? "",
      unclearReason: turn.unclearReason ?? "",
      revealedFactIds: turn.revealedFactIds ?? [],
    })),
    updatedAt: s.updatedAt ?? s.createdAt,
  }));
}

/** `language`, when given, also matches sessions saved with "" (unassigned,
 * predating multi-language support) so they aren't orphaned out of view —
 * same convention as cards.ts/topics.ts. */
export function loadConversations(language?: string): ConversationSession[] {
  const sessions = sanitizeConversations(loadDomainJson(STORAGE_NAME));
  return language ? sessions.filter((s) => s.language === language || s.language === "") : sessions;
}

function saveConversations(sessions: ConversationSession[], options?: StorageWriteOptions): void {
  saveJson(STORAGE_NAME, sessions, options);
}

export function subscribeConversations(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export interface NewConversationInput {
  language: string;
  title: string;
  scenario: string;
  mode?: ConversationMode;
  mission?: string;
  facts?: InquiryFact[];
  retryOfId?: string;
  /** The assistant's opening turn (and any further seed turns), so a fresh
   * session is created already showing its scenario-opening line. */
  turns?: ConversationTurn[];
}

export function addConversation(input: NewConversationInput): ConversationSession {
  const now = new Date().toISOString();
  const session: ConversationSession = {
    id: newId(),
    language: input.language,
    title: input.title.trim(),
    scenario: input.scenario.trim(),
    mode: input.mode ?? "free",
    mission: input.mission?.trim() ?? "",
    facts: input.facts ?? [],
    retryOfId: input.retryOfId ?? "",
    turns: input.turns ?? [],
    createdAt: now,
    endedAt: "",
    updatedAt: now,
  };
  // Newest first, capped at MAX_SESSIONS — oldest sessions fall off instead
  // of growing localStorage unboundedly.
  const sessions = [session, ...loadConversations()];
  persistDeletions([{ name: STORAGE_NAME, value: sessions.slice(0, MAX_SESSIONS) }],
    [{ store: "conversations", records: sessions.slice(MAX_SESSIONS) }]);
  return session;
}

/** Replaces the session with the given id by shallow-merging `patch` — same
 * "replace by id" shape as topics.ts's updateAttempt. Bumps `updatedAt`
 * (turn appends, ending a session, etc. all go through this one function). */
export function updateConversation(id: string, patch: Partial<Omit<ConversationSession, "id">>): void {
  const sessions = loadConversations().map((s) => (s.id === id ? { ...s, ...patch, updatedAt: nextUpdatedAt(s.updatedAt) } : s));
  saveConversations(sessions);
}

export function deleteConversation(id: string): void {
  const sessions = loadConversations();
  persistDeletions([{ name: STORAGE_NAME, value: sessions.filter((s) => s.id !== id) }],
    [{ store: "conversations", records: [{ id, updatedAt: sessions.find((s) => s.id === id)?.updatedAt }] }]);
}

/** Bulk-replaces the entire session store with `sessions` (one save, one
 * change event) — persistence only, no id lookup/merge and no MAX_SESSIONS
 * capping (that's addConversation's business logic, not the raw save path).
 * Only lib/sync/snapshot.ts should call this; every other write path goes
 * through addConversation/updateConversation/deleteConversation above so
 * `updatedAt`/tombstones stay correct. */
export function replaceConversationsForSync(sessions: ConversationSession[], options?: StorageWriteOptions): void {
  saveConversations(sessions, options);
}

/** Builds one turn with a fresh id — callers append it to a session's
 * `turns` and persist via updateConversation/addConversation. */
export function newTurn(input: {
  role: ConversationRole;
  text: string;
  reading?: string;
  translation?: string;
  corrected?: string;
  correctedReading?: string;
  correctedTranslation?: string;
  reasons?: string;
  suggestion?: string;
  suggestionReading?: string;
  suggestionTranslation?: string;
  suggestionReason?: string;
  understanding?: InquiryUnderstanding;
  unclearReason?: string;
  revealedFactIds?: string[];
}): ConversationTurn {
  return {
    id: newId(),
    role: input.role,
    text: input.text,
    reading: input.reading ?? "",
    translation: input.translation ?? "",
    corrected: input.corrected ?? "",
    correctedReading: input.correctedReading ?? "",
    correctedTranslation: input.correctedTranslation ?? "",
    reasons: input.reasons ?? "",
    suggestion: input.suggestion ?? "",
    suggestionReading: input.suggestionReading ?? "",
    suggestionTranslation: input.suggestionTranslation ?? "",
    suggestionReason: input.suggestionReason ?? "",
    understanding: input.understanding ?? "",
    unclearReason: input.unclearReason ?? "",
    revealedFactIds: input.revealedFactIds ?? [],
  };
}

export function revealedFactIds({ turns }: Pick<ConversationSession, "turns">): Set<string> {
  const revealed = new Set<string>();
  for (const turn of turns) {
    if (turn.role === "assistant") for (const id of turn.revealedFactIds) revealed.add(id);
  }
  return revealed;
}

export interface ConversationStartResult {
  title: string;
  scenario: string;
  opening: string;
  /** Always-visible reading aid for `opening` (e.g. pinyin — see
   * lib/languages.ts readingAid); "" for languages without one. */
  openingReading: string;
  /** Native-language translation of `opening`, revealed on demand (same idea
   * as ReadingPassage's per-sentence translation). */
  openingTranslation: string;
}

function parseConversationStart(content: string): ConversationStartResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const scenario = typeof parsed.scenario === "string" ? parsed.scenario : "";
  const opening = typeof parsed.opening === "string" ? parsed.opening : "";
  const openingReading = typeof parsed.openingReading === "string" ? parsed.openingReading : "";
  const openingTranslation = typeof parsed.openingTranslation === "string" ? parsed.openingTranslation : "";
  if (!title || !opening) throw new Error(t("talk-error-missing-start"));
  return { title, scenario, opening, openingReading, openingTranslation };
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
  topicRequest?: string;
}): Promise<ConversationStartResult> {
  // Always-visible reading aid (e.g. pinyin for Chinese — see
  // lib/languages.ts readingAid): only asked for when the target language
  // has one, so the prompt never mentions it for languages without a
  // hard-to-sound-out script.
  const aid = readingAid(params.targetLanguage);
  const keys = [
    `"title" (a short scenario label in ${params.nativeLanguage})`,
    `"scenario" (a one-sentence scenario instruction in ${params.nativeLanguage}, describing the setting/role you will play, for you to keep following in later turns)`,
    `"opening" (your opening line in ${params.targetLanguage})`,
    `"openingTranslation" (translation of "opening" in ${params.nativeLanguage})`,
  ];
  if (aid) keys.push(`"openingReading" (the reading of "opening", as ${aid.llmInstruction})`);
  // Same optional free-text steer as requestTopicSuggestion/requestReadingPassage's
  // topicRequest — takes priority over avoiding recentTitles when given.
  const topicRequestInstruction =
    params.topicRequest && params.topicRequest.trim()
      ? ` The learner described what kind of scenario they want (topicRequest): "${params.topicRequest.trim()}". Follow this request when inventing the scenario — it takes priority over avoiding recentTitles.`
      : "";
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's conversation partner for a learner of ${params.targetLanguage} (native language: ${params.nativeLanguage}). Invent one concrete, everyday scenario for a short dialogue (for example: ordering at a café, asking for directions, small talk about the weekend) — avoid repeating any scenario in recentTitles.${topicRequestInstruction} Write an opening line in ${params.targetLanguage} that invites the learner to reply, using simple, natural language, 1-2 short sentences. Return only JSON with exactly these keys: ${keys.join(", ")}.${levelInstruction(params.targetLanguage)}`,
    { recentTitles: params.recentTitles, topicRequest: params.topicRequest ?? "" },
  );
  return parseConversationStart(content);
}

export interface ConversationReplyResult {
  reply: string;
  /** Always-visible reading aid for `reply`; "" when the target language
   * has none. */
  replyReading: string;
  /** Native-language translation of `reply`, revealed on demand (same idea
   * as ReadingPassage's per-sentence translation). */
  replyTranslation: string;
  corrected: string;
  /** Always-visible reading aid for `corrected`; "" when the target
   * language has none, or when there is nothing to correct. */
  correctedReading: string;
  /** Native-language translation of `corrected`, revealed on demand; ""
   * when there is nothing to correct. */
  correctedTranslation: string;
  reasons: string;
  suggestion: string;
  suggestionReading: string;
  suggestionTranslation: string;
  suggestionReason: string;
}

export function parseReplySuggestion(parsed: Record<string, unknown>, corrected: string): Pick<
  ConversationReplyResult, "suggestion" | "suggestionReading" | "suggestionTranslation" | "suggestionReason"
> {
  const suggestion = !corrected && typeof parsed.suggestion === "string" ? parsed.suggestion.trim() : "";
  return {
    suggestion,
    suggestionReading: suggestion && typeof parsed.suggestionReading === "string" ? parsed.suggestionReading.trim() : "",
    suggestionTranslation: suggestion && typeof parsed.suggestionTranslation === "string" ? parsed.suggestionTranslation.trim() : "",
    suggestionReason: suggestion && typeof parsed.suggestionReason === "string" ? parsed.suggestionReason.trim() : "",
  };
}

function parseConversationReply(content: string): ConversationReplyResult {
  const parsed = extractJson(content) as Record<string, unknown>;
  const reply = typeof parsed.reply === "string" ? parsed.reply : "";
  const replyReading = typeof parsed.replyReading === "string" ? parsed.replyReading : "";
  const replyTranslation = typeof parsed.replyTranslation === "string" ? parsed.replyTranslation : "";
  const corrected = typeof parsed.corrected === "string" ? parsed.corrected : "";
  const correctedReading = typeof parsed.correctedReading === "string" ? parsed.correctedReading : "";
  const correctedTranslation = typeof parsed.correctedTranslation === "string" ? parsed.correctedTranslation : "";
  const reasons = typeof parsed.reasons === "string" ? parsed.reasons : "";
  if (!reply) throw new Error(t("talk-error-missing-reply"));
  return {
    reply, replyReading, replyTranslation, corrected, correctedReading, correctedTranslation, reasons,
    ...parseReplySuggestion(parsed, corrected),
  };
}

/** Continues an in-progress 会話 session: the AI replies in character (per
 * `scenario`), always inviting the learner to keep talking, and separately
 * reviews the learner's latest message for a correction or a clearly better
 * expression. Prior turns are stripped down to `{role, text}` so the model
 * sees just the dialogue. */
export async function requestConversationReply(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  scenario: string;
  turns: ConversationTurn[];
  learnerText: string;
}): Promise<ConversationReplyResult> {
  // See requestConversationStart's comment: only mention the reading-aid
  // keys at all when the target language has one.
  const aid = readingAid(params.targetLanguage);
  const keys = [`"reply" (your next line in ${params.targetLanguage})`];
  if (aid) keys.push(`"replyReading" (the reading of "reply", as ${aid.llmInstruction})`);
  keys.push(`"replyTranslation" (translation of "reply" in ${params.nativeLanguage})`);
  keys.push(`"corrected" (corrected ${params.targetLanguage} text, or "" if nothing to correct)`);
  if (aid) keys.push(`"correctedReading" (the reading of "corrected", as ${aid.llmInstruction}, or "" if "corrected" is "")`);
  keys.push(`"correctedTranslation" (translation of "corrected" in ${params.nativeLanguage}, or "" if "corrected" is "")`);
  keys.push(`"reasons" (explanation in ${params.nativeLanguage}, or "" if nothing to correct)`);
  keys.push(...suggestionKeys(params.targetLanguage, params.nativeLanguage, aid?.llmInstruction));
  const content = await chatJson(
    params.connection,
    `You are TC Lingo's conversation partner for a learner of ${params.targetLanguage} (native language: ${params.nativeLanguage}), continuing a scripted-scenario dialogue. Follow the scenario instruction (scenario) and continue the conversation naturally in ${params.targetLanguage} — simple, natural language, 1-2 short sentences, always ending in a way that invites the learner to keep talking (a question or a prompt). Separately, review the learner's latest message (learnerText) as feedback: ${APPROPRIATENESS_REVIEW} Return only JSON with these keys in this exact order: ${keys.join(", ")}.${levelInstruction(params.targetLanguage)}`,
    {
      scenario: params.scenario,
      turns: params.turns.map((turn) => ({ role: turn.role, text: turn.text })),
      learnerText: params.learnerText,
    },
  );
  return parseConversationReply(content);
}
