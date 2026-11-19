import { requestDecision } from "@tik-choco/mistai";
import type { DecisionRequest, DecisionTarget } from "@tik-choco/mistai";
import type { Card, CardSource } from "../types";
import { setAutoCardPriority } from "./cards";
import { effectiveBand } from "./level";
import type { judgeReviewAnswer } from "./llm";
import { decisionTargetForApp } from "./llmConnection";
import { rooms } from "./network";

type ImportanceCard = Pick<Card, "front" | "meaning" | "context" | "exampleSentence">;
type Languages = { targetLanguage: string; nativeLanguage: string };
type ImportanceContext = Languages & { source: CardSource };
type ReviewAnswer = Omit<Parameters<typeof judgeReviewAnswer>[0], "connection" | "fixedVerdict">;

async function decide(target: DecisionTarget | null, request: DecisionRequest, signal?: AbortSignal) {
  if (!target || signal?.aborted) return null;
  try {
    const response = await requestDecision(target, request, { rooms, signal });
    return signal?.aborted ? null : response.answers;
  } catch {
    return null;
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

export async function testDecisionTarget(target: DecisionTarget, signal?: AbortSignal): Promise<boolean> {
  const answer = (await decide(target, {
    state: { expression: "hello" },
    questions: { test: { type: "noul", instructions: "Is this expression an English greeting?" } },
  }, signal))?.test;
  return answer?.type === "noul" && isProbability(answer.noul);
}

export async function scoreCardImportance(
  card: ImportanceCard,
  options: ImportanceContext & { signal?: AbortSignal },
  target: DecisionTarget | null = decisionTargetForApp(),
): Promise<number | null> {
  if (!target || options.signal?.aborted) return null;
  const { targetLanguage, nativeLanguage, source, signal } = options;
  const questions: DecisionRequest["questions"] = {
    usefulness: {
      type: "score",
      instructions: `Rate how useful this expression is to learn for a ${nativeLanguage} speaker studying the target language at the stated CEFR level. Use general learners' needs when the level is unknown.`,
      criteria: [
        "Rare, highly specialized, or mostly useful as a proper name.",
        "Niche expression used infrequently or in a narrow context.",
        "Useful in some common situations or as part of a reusable pattern.",
        "Frequent and broadly useful at this learner's level.",
        "Essential, high-frequency language for this learner's level.",
      ],
    },
  };
  if (source === "mistake") {
    questions.recurring = {
      type: "noul",
      instructions: "Does this mistake card represent a systematic grammar or vocabulary gap likely to recur, rather than a one-off typo or slip?",
    };
  }
  const answers = await decide(target, {
    state: {
      expression: card.front, meaning: card.meaning, context: card.context,
      exampleSentence: card.exampleSentence, targetLanguage, learnerLevel: effectiveBand(targetLanguage) || null,
    },
    questions,
  }, signal);
  const usefulness = answers?.usefulness;
  if (usefulness?.type !== "score" || !isProbability(usefulness.score / 4)) return null;
  let priority = 0.1 + 0.8 * usefulness.score / 4;
  if (source === "mistake") {
    const recurring = answers?.recurring;
    if (recurring?.type !== "noul" || !isProbability(recurring.noul)) return null;
    priority += 0.2 * (recurring.noul - 0.5);
  }
  return Math.max(0, Math.min(1, priority));
}

export async function scoreCardImportanceBatch<T extends ImportanceCard>(cards: readonly T[], options: {
  context: (card: T) => ImportanceContext;
  signal?: AbortSignal;
  onScore: (card: T, priority: number, index: number) => void;
  onProgress?: (completed: number, total: number) => void;
}): Promise<void> {
  if (!cards.length || options.signal?.aborted) return;
  const target = decisionTargetForApp();
  if (!target) return;
  const { signal } = options;
  let next = 0;
  let completed = 0;
  async function worker() {
    while (!signal?.aborted && next < cards.length) {
      const index = next++;
      const card = cards[index];
      const score = await scoreCardImportance(card, { ...options.context(card), signal }, target);
      if (signal?.aborted) return;
      if (score !== null) options.onScore(card, score, index);
      options.onProgress?.(++completed, cards.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, cards.length) }, worker));
}

export function scoreSavedCards(cards: readonly Card[], options: Languages & {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  minimumPriority?: number;
}): Promise<void> {
  return scoreCardImportanceBatch(cards.filter((card) => card.prioritySource === "default"), {
    context: (card) => ({
      targetLanguage: card.language || options.targetLanguage,
      nativeLanguage: options.nativeLanguage,
      source: card.source,
    }),
    signal: options.signal,
    onProgress: options.onProgress,
    onScore: (card, score) => setAutoCardPriority(card, Math.max(score, options.minimumPriority ?? 0)),
  });
}

export async function quickJudgeAnswer(
  params: ReviewAnswer,
  signal?: AbortSignal,
): Promise<{ verdict: "correct" | "near" | "wrong"; confidence: number } | null> {
  const answer = (await decide(decisionTargetForApp(), {
    state: {
      ...params.card, cloze: params.displayedCloze, expectedAnswer: params.expectedAnswer,
      typedAnswer: params.typedAnswer, targetLanguage: params.targetLanguage, nativeLanguage: params.nativeLanguage,
    },
    questions: {
      verdict: {
        type: "choice",
        instructions: "Classify the learner's typed answer against the card's meaning and expectedAnswer. The front is the dictionary form for context. For a multi-blank cloze, expectedAnswer lists the fills separated by spaces in blank order. Judge the typed sequence in that same order.",
        criteria: {
          correct: "A synonym, alternative spelling or script, or equivalent phrasing with the card's meaning. When cloze is present, every part naturally and grammatically fills its corresponding blank.",
          near: "The learner clearly recalled the right expression but a part has the wrong form (such as tense, number, conjugation, politeness, or formality) or a minor spelling or typo slip.",
          wrong: "The answer has a different meaning, is unrelated, or is not a recognizable attempt. A similar spelling with a different meaning is wrong.",
        },
      },
    },
  }, signal))?.verdict;
  if (answer?.type !== "choice" || !isProbability(answer.confidence)) return null;
  const { choice, confidence } = answer;
  if (choice !== "correct" && choice !== "near" && choice !== "wrong") return null;
  return { verdict: choice, confidence };
}

export async function quickClozeConsistent(
  card: Pick<Card, "front" | "exampleSentence" | "cloze">,
  targetLanguage: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const answer = (await decide(decisionTargetForApp(), {
    state: { front: card.front, exampleSentence: card.exampleSentence, cloze: card.cloze, targetLanguage },
    questions: {
      consistent: {
        type: "noul",
        instructions: "Can the cloze blanks be filled in order to reproduce exampleSentence exactly, ignoring only whitespace differences, with each fill being front or a natural inflection of it? For a discontinuous front written with ellipses, verify that each part fills its own blank in order.",
      },
    },
  }, signal))?.consistent;
  return answer?.type === "noul" && isProbability(answer.noul) ? answer.noul : null;
}
