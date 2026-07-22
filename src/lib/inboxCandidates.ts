// Deterministic (no-LLM) mapping from a resolved `lingo-card-inbox` payload
// to flashcard candidates, plus the CardsView-facing entry point that picks
// the right mapping for an item's `kind`. Kept separate from cardInbox.ts
// (which owns subscription/idempotency/payload-fetch, not card shaping) —
// same split as lib/parse.ts (shaping) vs lib/llm.ts (network calls) vs
// lib/cards.ts (persistence) elsewhere in this app. The optional LLM-assisted
// extraction (`requestTranslationCards`) lives in lib/llm.ts alongside
// requestMistakeCards, since it needs the chatJson/connection plumbing that
// module already owns.
import type { CardCandidate } from "./parse";
import type { LingoCardInboxItem, LingoCardPayloadV1 } from "./cardInbox";

/** `explain`-kind payloads: one candidate per vocabulary entry. Entries
 * without at least a word and a meaning are dropped (mirrors
 * parseCardCandidates' `front && meaning` filter). A grammar point's
 * `example` is borrowed as `exampleSentence` only when its text actually
 * contains the vocabulary word — a deliberately narrow heuristic so
 * unrelated grammar notes don't get force-linked to the wrong word. */
function explainCandidates(payload: LingoCardPayloadV1): CardCandidate[] {
  const grammarExamples = (payload.grammarPoints ?? [])
    .map((g) => (g.example ?? "").trim())
    .filter((example) => example !== "");

  return (payload.vocabulary ?? [])
    .map((v) => ({ word: v.word.trim(), reading: (v.reading ?? "").trim(), meaning: v.meaning.trim(), note: (v.note ?? "").trim() }))
    .filter((v) => v.word !== "" && v.meaning !== "")
    .map((v) => ({
      front: v.word,
      reading: v.reading,
      meaning: v.meaning,
      exampleSentence: grammarExamples.find((example) => example.includes(v.word)) ?? "",
      exampleSentenceTranslation: "",
      context: v.note,
      cloze: "",
    }));
}

/** `translate`-kind payloads: a single sentence card, source text on the
 * front. The translation shown on the back prefers the "Natural" tone (tone
 * naming mirrors tc-translate's initialTranslationTones) and falls back to
 * whichever translation is first when no Natural entry was sent. `reading`
 * takes the matching translation's own reading, or its pinyin (Chinese
 * targets carry pinyin instead of a generic reading). */
function translateCandidates(payload: LingoCardPayloadV1): CardCandidate[] {
  if (payload.sourceText.trim() === "" || payload.translations.length === 0) return [];
  const chosen = payload.translations.find((tr) => tr.tone === "Natural") ?? payload.translations[0];
  if (chosen.text.trim() === "") return [];
  return [
    {
      front: payload.sourceText.trim(),
      reading: (chosen.reading ?? chosen.pinyin ?? "").trim(),
      meaning: chosen.text.trim(),
      exampleSentence: "",
      exampleSentenceTranslation: "",
      context: "",
      cloze: "",
    },
  ];
}

/** Picks the deterministic mapping for `item.kind`. `proofread` items never
 * reach the inbox (the sender excludes them from v1 — see the design doc),
 * so there's no third branch here. */
export function deterministicCandidates(item: LingoCardInboxItem, payload: LingoCardPayloadV1): CardCandidate[] {
  return item.kind === "explain" ? explainCandidates(payload) : translateCandidates(payload);
}
