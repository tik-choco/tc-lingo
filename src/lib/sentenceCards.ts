// Save-the-corrected-sentence-as-is layer: turns whichever sentences changed
// between a practice attempt's original and corrected text into SRS sentence
// cards (source: "sentence"), so they can be re-encountered as retrieval
// practice in the review tab later instead of only being seen once inline in
// FeedbackPanel. This is a thin sibling of lib/autoExtract.ts (mistake-card
// extraction) but keeps the sentence text verbatim rather than asking the AI
// to pick out reusable words/phrases from it.
import type { Card } from "../types";
import { addCard, loadCards } from "./cards";
import type { LlmConnection } from "./llmConnection";
import { requestSentenceCardInfo } from "./llm";
import { splitSentences } from "./spelling";

const MAX_SENTENCES = 5;

function frontKey(front: string): string {
  return front.trim().toLowerCase();
}

/** Which sentences in `corrected` are new/changed relative to `original`:
 * split corrected into sentences and drop any that appear verbatim (trimmed)
 * among original's sentences. Capped at MAX_SENTENCES so one large rewrite
 * doesn't flood the deck. Returns [] when the two texts are identical. */
export function changedCorrectedSentences(original: string, corrected: string): string[] {
  if (original.trim() === corrected.trim()) return [];
  const originalSet = new Set(splitSentences(original));
  const changed = splitSentences(corrected).filter((s) => !originalSet.has(s));
  return changed.slice(0, MAX_SENTENCES);
}

/** Extracts the changed sentences from a correction, fetches reading +
 * translation for each, and saves them as source: "sentence" cards, deduped
 * against the existing deck (and within the batch) the same way
 * autoExtractMistakeCards is. Returns [] without any LLM call when nothing
 * changed. Sentences the LLM response drops (or leaves without a
 * translation) are skipped rather than saved with a blank meaning — a card
 * with no translation can't support a review prompt. Throws on LLM/network
 * failure so the caller (a learner-triggered save action, not a background
 * one like autoExtract) can surface the error instead of silently doing
 * nothing. */
export async function saveSentenceCards(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  original: string;
  corrected: string;
  sourceTopicId?: string | null;
}): Promise<Card[]> {
  const sentences = changedCorrectedSentences(params.original, params.corrected);
  if (sentences.length === 0) return [];

  const infos = await requestSentenceCardInfo({
    connection: params.connection,
    targetLanguage: params.targetLanguage,
    nativeLanguage: params.nativeLanguage,
    sentences,
  });
  const infoBySentence = new Map(infos.map((i) => [i.sentence.trim(), i]));

  const existing = new Set(
    loadCards()
      .filter((c) => c.language === params.targetLanguage || c.language === "")
      .map((c) => frontKey(c.front)),
  );

  const added: Card[] = [];
  for (const sentence of sentences) {
    const info = infoBySentence.get(sentence.trim());
    if (!info || !info.translation) continue; // no translation → not reviewable, skip rather than fall back

    const key = frontKey(sentence);
    if (!key || existing.has(key)) continue;
    existing.add(key);

    added.push(
      addCard({
        front: sentence,
        reading: info.reading,
        meaning: info.translation,
        exampleSentence: "",
        context: "",
        cloze: "",
        source: "sentence",
        sourceTopicId: params.sourceTopicId ?? null,
        language: params.targetLanguage,
      }),
    );
  }
  return added;
}
