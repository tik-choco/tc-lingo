// Background cloze-variation prefetch, same "check the *next* queued card
// while the learner is busy with the current one" shape as
// lib/reviewConsistencyCheck.ts (see ReviewView.tsx). Distinct concern
// though: this doesn't fix bad data, it generates a fresh, ephemeral example
// sentence so a card reviewed more than once doesn't always show the exact
// same wording — see lib/llm.ts's requestClozeVariation header comment.
import type { Card } from "../types";
import { requestClozeVariation } from "./llm";
import { connectionForTask } from "./llmConnection";

/** Generates a fresh cloze variation for `card`, or null if there's nothing
 * to vary (no cloze, first-ever exposure, no connection) or the call
 * failed — callers fall back to the card's own stored `cloze` on null.
 * Never persisted: purely for this one display. */
export async function generateClozeVariation(card: Card, targetLanguage: string): Promise<string | null> {
  // reps === 0 means this is the learner's first time seeing this card at
  // all — keep the original, presumably carefully-chosen exampleSentence
  // for that first exposure, and only vary on repeat reviews.
  if (card.reps <= 0 || !card.cloze.trim() || !card.exampleSentence.trim()) return null;

  const connection = connectionForTask("generation");
  if (!connection) return null;

  try {
    return await requestClozeVariation({
      connection,
      targetLanguage,
      card: { front: card.front, reading: card.reading, meaning: card.meaning, exampleSentence: card.exampleSentence },
    });
  } catch (error) {
    console.warn("tc-lingo: cloze variation generation failed", error);
    return null;
  }
}
