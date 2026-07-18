// Background mistake→card auto-extraction: whenever a correction comes back
// (practice feedback, talk reply), views call this fire-and-forget to turn
// the mistake into SRS cards without the learner pressing the manual extract
// button. Gated on settings.autoExtractCards; deduped against the existing
// deck so repeated mistakes don't pile up duplicate cards. Errors are
// swallowed (console.warn) — auto-extraction is best-effort sugar on top of
// the manual flow, never something that should surface a failure state.
import type { Card } from "../types";
import { addCard, loadCards } from "./cards";
import type { LlmConnection } from "./llmConnection";
import { requestMistakeCards } from "./llm";
import { loadSettings } from "./settings";

function frontKey(front: string): string {
  return front.trim().toLowerCase();
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

  // Dedup against cards already in this language's deck ("" = unassigned,
  // visible under every filter — treat as a duplicate source too) and within
  // the batch itself.
  const existing = new Set(
    loadCards()
      .filter((c) => c.language === params.targetLanguage || c.language === "")
      .map((c) => frontKey(c.front)),
  );
  const added: Card[] = [];
  for (const candidate of candidates) {
    const key = frontKey(candidate.front);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    added.push(
      addCard({
        ...candidate,
        source: "mistake",
        sourceTopicId: params.sourceTopicId ?? null,
        language: params.targetLanguage,
      }),
    );
  }
  return added;
}
