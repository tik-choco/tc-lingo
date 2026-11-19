import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addCard, loadCards } from "../src/lib/cards";
import { quickClozeConsistent, quickJudgeAnswer, scoreCardImportance, scoreSavedCards } from "../src/lib/decision";
import { setLevelOverride } from "../src/lib/level";
import { decisionTargetForApp } from "../src/lib/llmConnection";
import { emptyLlmConfig, saveLlmConfig } from "../src/lib/llmConfig";
import { rooms } from "../src/lib/network";
import { loadSettings, saveSettings } from "../src/lib/settings";

vi.mock("../src/lib/network", () => ({ rooms: { requestRoomOpenAi: vi.fn() } }));

const languages = { targetLanguage: "English", nativeLanguage: "Japanese" };
const candidate = { front: "go", meaning: "to move", context: "", exampleSentence: "I go to school." };
const baseUrl = "http://localhost:11434/v1";

function configureDecision(base = baseUrl) {
  const config = emptyLlmConfig();
  config.providers.push({ id: "provider", label: "Provider", baseUrl: base, apiKey: "" });
  config.defaultModel = { providerId: "provider", model: "chat-model" };
  saveLlmConfig(config);
  const settings = loadSettings();
  settings.tasks.decision = { ref: { providerId: "provider", model: "nimble" }, reasoningEffort: "none" };
  saveSettings(settings);
  return { config, settings };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("requires an explicit usable task ref even when chat has a default model", async () => {
  const { settings } = configureDecision();
  expect(decisionTargetForApp()?.model).toBe("nimble");
  delete settings.tasks.decision;
  saveSettings(settings);
  expect(decisionTargetForApp()).toBeNull();
  settings.tasks.decision = { ref: { providerId: "deleted", model: "nimble" }, reasoningEffort: "none" };
  saveSettings(settings);
  const fetchDecision = vi.fn();
  vi.stubGlobal("fetch", fetchDecision);
  expect(await scoreCardImportance(candidate, { ...languages, source: "manual" })).toBeNull();
  expect(fetchDecision).not.toHaveBeenCalled();
});

it("sends the learner's level and combines typed usefulness and recurring answers", async () => {
  configureDecision();
  setLevelOverride("English", "B2");
  const fetchDecision = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    expect(request.model).toBe("nimble");
    expect(request.state).toEqual({
      expression: candidate.front, meaning: candidate.meaning, context: candidate.context,
      exampleSentence: candidate.exampleSentence, targetLanguage: "English", learnerLevel: "B2",
    });
    expect(request.questions.usefulness.criteria).toHaveLength(5);
    expect(request.questions.recurring.type).toBe("noul");
    return Response.json({ answers: { usefulness: { type: "score", score: 2.5 }, recurring: { type: "noul", noul: 0.9 } } });
  });
  vi.stubGlobal("fetch", fetchDecision);
  expect(await scoreCardImportance(candidate, { ...languages, source: "mistake" })).toBeCloseTo(0.68);
  expect(fetchDecision.mock.calls[0][0]).toBe(baseUrl + "/systemone");
});

it("uses the app room tunnel and falls back on HTTP errors or malformed confidence", async () => {
  configureDecision("mist-network://room");
  const requestRoom = vi.mocked(rooms.requestRoomOpenAi);
  const response = (answers: Record<string, unknown>) => ({
    status: 200, contentType: "application/json", body: JSON.stringify({ answers }),
  });
  requestRoom.mockResolvedValueOnce(response({ consistent: { type: "noul", noul: 0.8 } }));
  expect(await quickClozeConsistent({ ...candidate, cloze: "I ___ to school." }, "English")).toBe(0.8);
  expect(requestRoom.mock.calls[0]).toEqual([
    "room", expect.objectContaining({ method: "POST", path: "/systemone" }),
  ]);
  const answer = {
    ...languages, card: { ...candidate, reading: "" }, displayedCloze: "", expectedAnswer: "go", typedAnswer: "travel",
  };
  requestRoom.mockResolvedValueOnce(response({ verdict: { type: "choice", choice: "correct", confidence: 0.9 } }));
  expect(await quickJudgeAnswer(answer)).toEqual({ verdict: "correct", confidence: 0.9 });
  requestRoom.mockResolvedValueOnce(response({ verdict: { type: "choice", choice: "correct", confidence: "0.9" } }));
  expect(await quickJudgeAnswer(answer)).toBeNull();
  requestRoom.mockResolvedValueOnce({ status: 404, contentType: "text/plain", body: "" });
  expect(await quickJudgeAnswer(answer)).toBeNull();
});

it("limits each batch to three requests and ignores pending scores once cancelled", async () => {
  configureDecision();
  const cards = Array.from({ length: 5 }, (_, i) => addCard({ front: String(i), meaning: "number" }));
  const controller = new AbortController();
  const progress = vi.fn();
  const resolvers: ((response: Response) => void)[] = [];
  const fetchDecision = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
  vi.stubGlobal("fetch", fetchDecision);
  const batch = scoreSavedCards(cards, { ...languages, signal: controller.signal, onProgress: progress });
  expect(fetchDecision).toHaveBeenCalledTimes(3);
  controller.abort();
  for (const resolve of resolvers) resolve(Response.json({ answers: { usefulness: { type: "score", score: 4 } } }));
  await batch;
  expect(progress).not.toHaveBeenCalled();
  expect(fetchDecision).toHaveBeenCalledTimes(3);
  expect(loadCards().map((card) => card.prioritySource)).toEqual(Array(5).fill("default"));
});
