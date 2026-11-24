import type { CefrBand, ConversationSession, ConversationTurn, InquiryFact, InquiryUnderstanding } from "../types";
import type { ConversationReplyResult, ConversationStartResult } from "./conversation";
import type { LlmConnection } from "./llmConnection";
import { APPROPRIATENESS_REVIEW, parseReplySuggestion, revealedFactIds, suggestionKeys } from "./conversation";
import { readingAid } from "./languages";
import { effectiveBand, levelInstruction } from "./level";
import { chatJson } from "./llm";
import { extractJson } from "./parse";
import { t } from "../i18n";

interface InquiryStartResult extends ConversationStartResult {
  mission: string;
  facts: InquiryFact[];
}

export interface InquiryReplyResult extends ConversationReplyResult {
  understanding: Exclude<InquiryUnderstanding, "">;
  unclearReason: string;
  revealedFactIds: string[];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseInquiryStart(content: string): InquiryStartResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = (extractJson(content) ?? {}) as Record<string, unknown>;
  } catch {
    throw new Error(t("talk-inquiry-error-missing-start"));
  }
  const title = readString(parsed.title);
  const scenario = readString(parsed.scenario);
  const mission = readString(parsed.mission);
  const opening = readString(parsed.opening);
  const facts: InquiryFact[] = [];
  if (Array.isArray(parsed.facts)) {
    for (const entry of parsed.facts) {
      if (!entry || typeof entry !== "object") continue;
      const label = readString(entry.label);
      const detail = readString(entry.detail);
      if (!label || !detail) continue;
      facts.push({ id: readString(entry.id), label, detail });
      if (facts.length === 6) break;
    }
  }
  if (!title || !scenario || !mission || !opening || facts.length < 2) {
    throw new Error(t("talk-inquiry-error-missing-start"));
  }
  const ids = new Set(facts.map((fact) => fact.id));
  if (ids.has("") || ids.size !== facts.length) {
    facts.forEach((fact, index) => { fact.id = `f${index + 1}`; });
  }
  return {
    title, scenario, mission, facts, opening,
    openingReading: readString(parsed.openingReading),
    openingTranslation: readString(parsed.openingTranslation),
  };
}

export async function requestInquiryStart(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  recentTitles: string[];
  topicRequest?: string;
}): Promise<InquiryStartResult> {
  const { connection, targetLanguage, nativeLanguage, recentTitles } = params;
  const topicRequest = params.topicRequest?.trim() ?? "";
  const aid = readingAid(targetLanguage);
  const keys = [
    `"title" (a short scenario label in ${nativeLanguage})`,
    `"scenario" (a one-sentence instruction in ${nativeLanguage} specifying the setting and the role you will keep playing)`,
    `"mission" (1-2 sentences in ${nativeLanguage} telling the learner what to find out, without giving away answers)`,
    `"facts" (3-5 items, each with "id" such as "f1", a short "label" in ${nativeLanguage} saying what to find out, and a concrete "detail" with the answer in ${targetLanguage})`,
    `"opening" (your in-role opening line in ${targetLanguage}, without revealing any fact)`,
    `"openingTranslation" (translation of "opening" in ${nativeLanguage})`,
  ];
  if (aid) keys.push(`"openingReading" (the reading of "opening", as ${aid.llmInstruction})`);
  const content = await chatJson(
    connection,
    `You are TC Lingo's conversation partner for a learner of ${targetLanguage} (native language: ${nativeLanguage}). Invent one concrete, everyday information-gap situation where you hold information the learner needs to ask you for. For example, play restaurant staff taking a reservation, a hotel receptionist, a friend planning a trip, a landlord, or a clinic receptionist. Avoid repeating scenarios in recentTitles. If topicRequest is provided, follow it first. Make some facts require specific questions about numbers, conditions, or days. Do not give away the answers in the title, scenario, mission, fact labels, or opening. Keep the opening natural and short. Return only JSON with exactly these keys: ${keys.join(", ")}.${levelInstruction(targetLanguage)}`,
    { recentTitles, topicRequest },
  );
  return parseInquiryStart(content);
}

export function inquiryStrictnessInstruction(band: CefrBand | ""): string {
  if (band === "C1" || band === "C2") {
    return "Be strict: also ask back when the phrasing is so unnatural or inappropriate for the register that a native listener would hesitate.";
  }
  if (band === "B1" || band === "B2") {
    return "Be moderately strict: also ask back when the wording would genuinely mislead or confuse a native listener.";
  }
  return "Be lenient: only ask back when the meaning truly cannot be recovered or a key detail (day, number, or which item) is ambiguous.";
}

export function parseInquiryReply(content: string, facts: InquiryFact[]): InquiryReplyResult {
  const parsed = (extractJson(content) ?? {}) as Record<string, unknown>;
  const reply = readString(parsed.reply);
  if (!reply) throw new Error(t("talk-error-missing-reply"));
  const understanding = parsed.understanding === "partial" || parsed.understanding === "none" ? parsed.understanding : "full";
  const knownIds = new Set(facts.map((fact) => fact.id));
  const ids = understanding === "full" && Array.isArray(parsed.revealedFactIds)
    ? parsed.revealedFactIds.filter((id): id is string => typeof id === "string" && knownIds.has(id))
    : [];
  const corrected = readString(parsed.corrected);
  return {
    understanding,
    unclearReason: understanding === "full" ? "" : readString(parsed.unclearReason),
    reply,
    replyReading: readString(parsed.replyReading),
    replyTranslation: readString(parsed.replyTranslation),
    revealedFactIds: [...new Set(ids)],
    corrected,
    correctedReading: readString(parsed.correctedReading),
    correctedTranslation: readString(parsed.correctedTranslation),
    reasons: readString(parsed.reasons),
    ...parseReplySuggestion(parsed, corrected),
  };
}

export async function requestInquiryReply(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  scenario: string;
  mission: string;
  facts: InquiryFact[];
  revealedFactIds: ReadonlySet<string>;
  turns: ConversationTurn[];
  learnerText: string;
}): Promise<InquiryReplyResult> {
  const { connection, targetLanguage, nativeLanguage, scenario, mission, facts, turns, learnerText } = params;
  const aid = readingAid(targetLanguage);
  const keys = [
    `"understanding" ("full", "partial", or "none", judged before replying)`,
    `"unclearReason" (what was unclear and how to say it more clearly, in ${nativeLanguage}, or "" when understanding is "full")`,
    `"reply" (your next line in ${targetLanguage})`,
  ];
  if (aid) keys.push(`"replyReading" (the reading of "reply", as ${aid.llmInstruction})`);
  keys.push(`"replyTranslation" (translation of "reply" in ${nativeLanguage})`);
  keys.push(`"revealedFactIds" (array of ids of facts whose information this reply actually conveys, or [])`);
  keys.push(`"corrected" (corrected ${targetLanguage} text, or "" if nothing to correct)`);
  if (aid) keys.push(`"correctedReading" (the reading of "corrected", as ${aid.llmInstruction}, or "" if "corrected" is "")`);
  keys.push(`"correctedTranslation" (translation of "corrected" in ${nativeLanguage}, or "" if "corrected" is "")`);
  keys.push(`"reasons" (concise explanation in ${nativeLanguage}, or "" if nothing to correct)`);
  keys.push(...suggestionKeys(targetLanguage, nativeLanguage, aid?.llmInstruction));
  const content = await chatJson(
    connection,
    [
      `You are TC Lingo's conversation partner for a learner of ${targetLanguage} (native language: ${nativeLanguage}). Stay in the role described in scenario and use facts as the source of your information. Answer only what was asked, never volunteer facts the learner didn't ask for, and use 1-2 short sentences.`,
      `Before replying, judge understanding from learnerText in the context of the dialogue as a real native listener would. Use "full" when the intended meaning is clear, "partial" when part of it is unclear, and "none" when you cannot recover what the learner means. Do not pretend to misunderstand a clear message. Grammar mistakes alone are not a reason to ask back if meaning is recoverable. ${inquiryStrictnessInstruction(effectiveBand(targetLanguage))}`,
      `When understanding is "partial" or "none", reply with exactly one realistic clarification request in ${targetLanguage} and reveal no facts. Prefer confirming the most likely interpretation ("Do you mean ...?") or ask about the specific unclear part. If the question is vague but answerable and understanding is "full", you may answer the clear scope and ask a follow-up.`,
      `Roughly once every 3-4 replies, naturally use one word or phrase slightly above the learner's level so they can practice asking what it means. When the learner asks for clarification of your words, rephrase simply. Treat asking for clarification as a valid turn.`,
      `For revealedFactIds, report only the ids whose information this reply actually conveys, even if it repeats one. Return [] for a clarification request. Do not disclose additional facts in translations or feedback. You may wrap up naturally when all facts have been revealed across the dialogue.`,
      `Separately review learnerText as feedback (this never affects your in-role reply): ${APPROPRIATENESS_REVIEW} When learnerText asks for clarification of your words (e.g. "What does X mean?"), leave all suggestion fields empty unless the request itself is phrased unnaturally or rudely. Return only JSON with these keys in this exact order: ${keys.join(", ")}.${levelInstruction(targetLanguage)}`,
    ].join(" "),
    { scenario, mission, facts, revealedFactIds: [...params.revealedFactIds], turns: turns.map(({ role, text }) => ({ role, text })), learnerText },
  );
  return parseInquiryReply(content, facts);
}

export function isInquiryClarification(turn: ConversationTurn): boolean {
  return turn.role === "learner" && (turn.understanding === "partial" || turn.understanding === "none");
}

export function summarizeInquiry(session: ConversationSession) {
  const revealed = revealedFactIds(session);
  const unclearTurns = session.turns.filter(isInquiryClarification);
  return {
    total: session.facts.length,
    obtained: session.facts.filter((fact) => revealed.has(fact.id)),
    missed: session.facts.filter((fact) => !revealed.has(fact.id)),
    clarificationCount: unclearTurns.length,
    unclearTurns,
  };
}
