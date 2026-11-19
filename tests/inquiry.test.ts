import { expect, it } from "vitest";
import { t } from "../src/i18n";
import { newTurn, revealedFactIds, sanitizeConversations } from "../src/lib/conversation";
import { inquiryStrictnessInstruction, parseInquiryReply, parseInquiryStart, summarizeInquiry } from "../src/lib/inquiry";
import { createVaultAdapter } from "../src/lib/vault/adapter";

const legacyTurn = { id: "opening", role: "assistant", text: "How can I help?", corrected: "", reasons: "" };
const legacySession = {
  id: "hotel", language: "English", title: "Reception", scenario: "Play the receptionist.",
  createdAt: "2026-11-19T00:00:00.000Z", endedAt: "", turns: [legacyTurn],
};

const facts = [
  { id: "f1", label: "開始時刻", detail: "Breakfast starts at seven." },
  { id: "f2", label: "駐車場", detail: "Parking is available on Sundays." },
];

const start = {
  title: " ホテル ", scenario: "フロント係を演じる。", mission: "朝食と駐車場について質問しよう。",
  opening: "How can I help?", openingTranslation: "ご用件をお伺いします。", facts,
};

it("backfills legacy sessions and turns while retaining existing revisions", () => {
  const updatedAt = "2026-11-19T00:02:00.000Z";
  const [legacy, current] = sanitizeConversations([legacySession, { ...legacySession, updatedAt }]);
  expect(legacy).toEqual({
    ...legacySession, updatedAt: legacySession.createdAt, mode: "free", mission: "", facts: [], retryOfId: "",
    turns: [{
      ...legacyTurn, reading: "", translation: "", correctedReading: "", correctedTranslation: "",
      understanding: "", unclearReason: "", revealedFactIds: [],
    }],
  });
  expect(current.updatedAt).toBe(updatedAt);
});

it("rejects wrong field types and filters malformed facts and unknown modes", () => {
  const badTurns = [
    { understanding: false }, { understanding: "unknown" }, { unclearReason: 10 }, { revealedFactIds: "f1" }, { revealedFactIds: [5] },
  ];
  expect(sanitizeConversations([
    { ...legacySession, mode: 9 }, { ...legacySession, mission: false }, { ...legacySession, facts: "f1" },
    { ...legacySession, retryOfId: null }, ...badTurns.map((patch) => ({ ...legacySession, turns: [{ ...legacyTurn, ...patch }] })),
  ])).toEqual([]);
  expect(sanitizeConversations([
    { ...legacySession, mode: "unknown", facts: [facts[0], null, { ...facts[1], id: "" }, { id: "f3", label: "Invalid", detail: 10 }] },
  ])[0]).toMatchObject({ mode: "free", facts: [facts[0]] });
});

it("parses valid mission openings and retains valid unique fact IDs", () => {
  expect(parseInquiryStart("```json\n" + JSON.stringify(start) + "\n```")).toEqual({
    ...start, title: "ホテル", openingReading: "",
  });
});

it("renumbers missing IDs and caps the number of usable facts at six", () => {
  const entries = [
    { label: "有効", detail: "The answer." }, facts[0], null, { label: "不正", detail: 123 },
    ...Array.from({ length: 5 }, (_, index) => ({ ...facts[1], id: `extra-${index}` })),
  ];
  const result = parseInquiryStart(JSON.stringify({ ...start, facts: entries }));
  expect(result.facts.map((fact) => fact.id)).toEqual(["f1", "f2", "f3", "f4", "f5", "f6"]);
  expect(result.facts.map((fact) => fact.label)).toEqual(["有効", "開始時刻", "駐車場", "駐車場", "駐車場", "駐車場"]);
});

it("renumbers duplicate IDs without dropping valid fact content", () => {
  const duplicates = [facts[0], { ...facts[1], id: "f1" }];
  expect(parseInquiryStart(JSON.stringify({ ...start, facts: duplicates })).facts).toEqual(facts);
});

it("requires a title, scenario, mission, opening and at least two usable facts", () => {
  const missing = [{ title: " " }, { scenario: null }, { mission: "" }, { opening: [] }, { facts: [facts[0]] }];
  for (const fields of missing) {
    expect(() => parseInquiryStart(JSON.stringify({ ...start, ...fields }))).toThrow(t("talk-inquiry-error-missing-start"));
  }
  expect(() => parseInquiryStart("null")).toThrow(t("talk-inquiry-error-missing-start"));
  expect(() => parseInquiryStart("invalid JSON")).toThrow(t("talk-inquiry-error-missing-start"));
});

it("validates and deduplicates revealed IDs and defaults unknown understanding to full", () => {
  const result = parseInquiryReply(JSON.stringify({
    understanding: "unknown", unclearReason: "Ignored", reply: " Breakfast starts at seven. ",
    replyReading: "reading", replyTranslation: "朝食は7時からです。", revealedFactIds: ["f1", "unknown", 99, "f1"],
    corrected: "When does breakfast start?", correctedReading: "corrected reading", correctedTranslation: "朝食は何時からですか？", reasons: "理由",
  }), facts);
  expect(result).toEqual({
    understanding: "full", unclearReason: "", reply: "Breakfast starts at seven.", replyReading: "reading",
    replyTranslation: "朝食は7時からです。", revealedFactIds: ["f1"], corrected: "When does breakfast start?",
    correctedReading: "corrected reading", correctedTranslation: "朝食は何時からですか？", reasons: "理由",
  });
});

it.each(["partial", "none"])("clears revealed IDs when understanding is %s", (understanding) => {
  expect(parseInquiryReply(JSON.stringify({
    understanding, unclearReason: "曜日を指定してください。", reply: "Do you mean Sunday?", revealedFactIds: ["f2"],
  }), facts)).toEqual({
    understanding, unclearReason: "曜日を指定してください。", reply: "Do you mean Sunday?", revealedFactIds: [],
    replyReading: "", replyTranslation: "", corrected: "", correctedReading: "", correctedTranslation: "", reasons: "",
  });
});

it("requires a non-empty inquiry reply", () => {
  expect(() => parseInquiryReply('{"reply":" "}', facts)).toThrow(t("talk-error-missing-reply"));
});

it("summarizes facts and clarification turns from the current dialogue", () => {
  const unclear = newTurn({ role: "learner", text: "And Sunday?", understanding: "partial" });
  const answer = newTurn({ role: "assistant", text: facts[0].detail, revealedFactIds: ["f1", "f1"] });
  const turns = [
    unclear, newTurn({ role: "assistant", text: "Sunday parking or breakfast?" }),
    newTurn({ role: "learner", text: "When does breakfast start?", understanding: "full", revealedFactIds: ["f2"] }),
    answer,
  ];
  const [session] = sanitizeConversations([{ ...legacySession, mode: "inquiry", facts, turns }]);
  expect(revealedFactIds(session)).toEqual(new Set(["f1"]));
  expect(summarizeInquiry(session)).toEqual({
    total: 2, obtained: [facts[0]], missed: [facts[1]], clarificationCount: 1, unclearTurns: [unclear],
  });
  expect(revealedFactIds({ turns: session.turns.slice(0, -2) })).toEqual(new Set());
});

it("uses three clarification thresholds across CEFR bands", () => {
  const lenient = inquiryStrictnessInstruction("");
  const moderate = inquiryStrictnessInstruction("B1");
  const strict = inquiryStrictnessInstruction("C1");
  expect(inquiryStrictnessInstruction("A1")).toBe(lenient);
  expect(inquiryStrictnessInstruction("A2")).toBe(lenient);
  expect(inquiryStrictnessInstruction("B2")).toBe(moderate);
  expect(inquiryStrictnessInstruction("C2")).toBe(strict);
  expect(new Set([lenient, moderate, strict]).size).toBe(3);
});

it("preserves inquiry metadata in vault checkpoints and accepts checkpoints predating it", () => {
  const adapter = createVaultAdapter();
  const checkpoint = { v: 1, app: "tc-lingo", cards: [], topics: [], attempts: [], passages: [], levels: [], tombstones: [] };
  const legacy = [{
    ...legacySession, updatedAt: legacySession.createdAt,
    turns: [{ ...legacyTurn, reading: "", translation: "", correctedReading: "", correctedTranslation: "" }],
  }];
  expect(adapter.parse({ ...checkpoint, conversations: legacy }).conversations).toEqual(sanitizeConversations(legacy));

  const inquiry = sanitizeConversations([{
    ...legacy[0], mode: "inquiry", mission: start.mission, facts, retryOfId: "previous",
    turns: [
      newTurn({ role: "assistant", text: facts[0].detail, revealedFactIds: ["f1"] }),
      newTurn({ role: "learner", text: "And Sunday?", understanding: "partial", unclearReason: "曜日と項目を指定してください。" }),
    ],
  }]);
  expect(adapter.parse({ ...checkpoint, conversations: inquiry }).conversations).toEqual(inquiry);
});
