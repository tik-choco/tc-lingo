// Background mistake→card auto-extraction: whenever a correction comes back
// (practice feedback, talk reply), views call this fire-and-forget to turn
// the mistake into SRS cards without the learner pressing the manual extract
// button. Gated on settings.autoExtractCards; deduped against the existing
// deck so repeated mistakes don't pile up duplicate cards. Errors are
// swallowed (console.warn) — auto-extraction is best-effort sugar on top of
// the manual flow, never something that should surface a failure state.
import type { Card } from "../types";
import { addCard, loadCards, PRIORITY_HIGH } from "./cards";
import { scoreSavedCards } from "./decision";
import type { LlmConnection } from "./llmConnection";
import type { CardCandidate } from "./parse";
import { requestMistakeCards } from "./llm";
import { loadSettings } from "./settings";

function frontKey(front: string): string {
  return front.trim().toLowerCase();
}

/** Match against the target deck, including cards with no assigned language. */
export function matchMistakeCards(candidates: readonly CardCandidate[], language: string): (string | undefined)[] {
  const existing = new Map<string, string>();
  for (const card of loadCards()) {
    if (card.language === language || card.language === "") {
      const key = frontKey(card.front);
      if (key && !existing.has(key)) existing.set(key, card.id);
    }
  }
  return candidates.map((candidate) => existing.get(frontKey(candidate.front)));
}

/** Runs the mistake-card extraction for one correction and adds the deduped
 * results to the deck. Returns the cards actually added ([] when the feature
 * is off, there was nothing to extract, everything was a duplicate, or the
 * LLM call failed). */
export async function autoExtractMistakeCards(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  original: string;
  corrected: string;
  reasons: string;
  sourceTopicId?: string | null;
  priority?: number;
  onDuplicate?: (cardId: string) => void;
}): Promise<Card[]> {
  if (!loadSettings().autoExtractCards) return [];
  const original = params.original.trim();
  const corrected = params.corrected.trim();
  if (!original || !corrected || original === corrected) return [];

  let candidates;
  try {
    candidates = await requestMistakeCards({
      connection: params.connection,
      targetLanguage: params.targetLanguage,
      nativeLanguage: params.nativeLanguage,
      original,
      corrected,
      reasons: params.reasons,
    });
  } catch (err) {
    console.warn("tc-lingo: mistake-card auto-extraction failed", err);
    return [];
  }

  const matches = matchMistakeCards(candidates, params.targetLanguage);
  const addedFronts = new Set<string>();
  const added: Card[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const match = matches[index];
    if (match !== undefined) {
      params.onDuplicate?.(match);
      continue;
    }
    const key = frontKey(candidate.front);
    if (!key || addedFronts.has(key)) continue;
    addedFronts.add(key);
    added.push(
      addCard({
        ...candidate,
        source: "mistake",
        sourceTopicId: params.sourceTopicId ?? null,
        language: params.targetLanguage,
        priority: params.priority,
      }),
    );
  }
  void scoreSavedCards(added, {
    targetLanguage: params.targetLanguage,
    nativeLanguage: params.nativeLanguage,
    minimumPriority: params.priority === PRIORITY_HIGH ? PRIORITY_HIGH : undefined,
  });
  return added;
}
