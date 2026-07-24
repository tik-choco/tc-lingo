// Background flashcard QA, scoped to the review queue: ReviewView calls
// checkCardConsistency for the *next* queued card while the learner is still
// occupied answering the current one, so a bad front/cloze pairing (see
// lib/llm.ts's requestCardConsistencyCheck header comment) is already fixed
// by the time they reach it — no separate pass over the whole deck, no
// added latency to the review flow itself. Same "fire-and-forget, swallow
// errors" shape as lib/autoExtract.ts/lib/cardAutoOrganize.ts; always on
// (no settings toggle) since it only ever fixes cards, never merges/deletes
// them, so there's nothing destructive to gate behind an opt-in.
import type { Card } from "../types";
import { updateCard } from "./cards";
import { hashCardConsistencyInput, loadCardConsistencyCache, markCardConsistencyChecked } from "./cardConsistencyCache";
import { deriveClozeGaps } from "./clozeFill";
import { requestCardConsistencyCheck } from "./llm";
import { connectionForTask } from "./llmConnection";

/** Checks (and, if needed, fixes and persists) one card's front/cloze
 * consistency. No-ops if the card has no cloze/exampleSentence to check
 * against, this exact content was already checked before, or (the common
 * case) the deterministic alignment check already proves it's fine — under
 * the front-stays-base-form model, a card is consistent whenever cloze's
 * blank(s) align against exampleSentence at all (lib/clozeFill.ts's
 * deriveClozeGaps), regardless of whether the fill is front verbatim, an
 * inflected form of it, or (for a discontinuous front) each part in order,
 * so most cards never need the LLM fallback below.
 * Returns the fixed card (already persisted via updateCard) if a fix was
 * applied, otherwise null — including on any failure, best-effort only. */
export async function checkCardConsistency(card: Card, targetLanguage: string): Promise<Card | null> {
  if (!card.cloze.trim() || !card.exampleSentence.trim()) return null;

  const originalHash = hashCardConsistencyInput(card.front, card.cloze, card.exampleSentence);
  if (loadCardConsistencyCache()[card.id] === originalHash) return null;

  if (deriveClozeGaps(card.exampleSentence, card.cloze)) {
    markCardConsistencyChecked(card.id, originalHash);
    return null;
  }

  const connection = connectionForTask("generation");
  if (!connection) return null;

  try {
    const result = await requestCardConsistencyCheck({
      connection,
      targetLanguage,
      card: { front: card.front, exampleSentence: card.exampleSentence, cloze: card.cloze },
    });

    if (result.consistent || !result.front.trim() || !result.cloze.trim()) {
      markCardConsistencyChecked(card.id, originalHash);
      return null;
    }

    updateCard(card.id, { front: result.front, cloze: result.cloze });
    markCardConsistencyChecked(card.id, hashCardConsistencyInput(result.front, result.cloze, card.exampleSentence));
    return { ...card, front: result.front, cloze: result.cloze };
  } catch (error) {
    console.warn("tc-lingo: card consistency check failed", error);
    return null;
  }
}
