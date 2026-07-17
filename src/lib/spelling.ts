// Heuristic spelling-mistake extraction for a single practice attempt (原文
// vs 修正版). Pairs a word that only appears in the learner's original text
// with a close-by-edit-distance word that only appears in the AI's corrected
// text, so the SpellingDrill component can make the learner retype exactly
// the words they got wrong. This is intentionally a word-level heuristic, not
// a real spellchecker — it has no dictionary and no language model.
//
// The word-boundary regex below only recognizes whitespace/punctuation-
// delimited "words" (letters, marks, digits, apostrophes, hyphens). For
// languages without whitespace-delimited words (Japanese, Chinese) this
// tokenizes each sentence into one or a few long character runs instead of
// individual words, which essentially never pair up under the edit-distance
// threshold below. That means this function naturally returns [] for those
// languages — expected, not a bug; spelling drills as such don't really
// apply to those scripts anyway.

export interface MisspelledWord {
  /** What the learner actually typed. */
  attempted: string;
  /** The corrected spelling from the AI feedback. */
  correct: string;
}

const WORD_PATTERN = /[\p{L}\p{M}\p{N}'’-]+/gu;
const NUMERIC_PATTERN = /^\p{N}+$/u;

function tokenize(text: string): string[] {
  return text.match(WORD_PATTERN) ?? [];
}

/** Code-point-aware Levenshtein edit distance between two words. O(n*m),
 * fine here since inputs are single words, not sentences. */
function levenshtein(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev: number[] = new Array(m + 1);
  let curr: number[] = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;

  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

interface WordInstance {
  /** Original casing, as it appeared in the source text. */
  word: string;
  /** Lowercased form, used for comparisons/dedup. */
  lower: string;
}

/** Dedupe a token list case-insensitively (first occurrence wins, keeping
 * its casing), preserving first-appearance order, and dropping purely
 * numeric tokens. */
function uniqueWords(tokens: string[]): WordInstance[] {
  const seen = new Set<string>();
  const result: WordInstance[] = [];
  for (const token of tokens) {
    if (NUMERIC_PATTERN.test(token)) continue;
    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push({ word: token, lower });
  }
  return result;
}

export interface CorrectedSentence {
  /** The learner's original sentence. */
  attempted: string;
  /** The AI-corrected version of that sentence. */
  correct: string;
}

const MAX_PAIRS = 5;

/** Extract likely spelling mistakes by pairing words that appear only in the
 * original with close-by-edit-distance words that appear only in the
 * corrected text. Feeds the SpellingDrill (repeated-typing practice). */
export function misspelledWords(original: string, corrected: string): MisspelledWord[] {
  const originalTokens = tokenize(original);
  const correctedTokens = tokenize(corrected);

  const originalLowerSet = new Set(originalTokens.map((w) => w.toLowerCase()));
  const correctedLowerSet = new Set(correctedTokens.map((w) => w.toLowerCase()));

  // Words that changed entirely (case-only differences are not misspellings).
  const originalOnly = uniqueWords(originalTokens).filter((w) => !correctedLowerSet.has(w.lower));
  const correctedOnly = uniqueWords(correctedTokens).filter((w) => !originalLowerSet.has(w.lower));

  // Pool of not-yet-claimed original-only words; each may be used at most once.
  const available = originalOnly.slice();
  const pairs: MisspelledWord[] = [];

  for (const candidate of correctedOnly) {
    if (pairs.length >= MAX_PAIRS) break;

    const correctLength = [...candidate.word].length;
    if (correctLength < 2) continue;

    const maxDistance = Math.max(1, Math.floor(correctLength / 3));

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < available.length; i += 1) {
      const distance = levenshtein(available[i].lower, candidate.lower);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (bestIndex !== -1 && bestDistance > 0 && bestDistance <= maxDistance) {
      const match = available[bestIndex];
      pairs.push({ attempted: match.word, correct: candidate.word });
      available.splice(bestIndex, 1);
    }
  }

  return pairs;
}

const MAX_SENTENCES = 3;

/** Split text into sentences on terminal punctuation (Latin and CJK), so
 * sentence-level practice works for Japanese/Chinese too, where the
 * word-level pairing above intentionally yields nothing. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])/u)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 2);
}

/** Sentence-level counterpart to misspelledWords: pair each corrected
 * sentence that changed with the learner's original version of it, so the
 * SpellingDrill can offer retyping the whole corrected sentence (not just
 * isolated words). Sentences the AI rewrote beyond recognition (edit
 * distance above ~50% of their length) are skipped — copy-typing a sentence
 * that shares nothing with what the learner wrote drills nothing. */
export function correctedSentences(original: string, corrected: string): CorrectedSentence[] {
  const originalSentences = splitSentences(original);
  const correctedList = splitSentences(corrected);
  const originalSet = new Set(originalSentences);

  const available = originalSentences.slice();
  const pairs: CorrectedSentence[] = [];

  for (const sentence of correctedList) {
    if (pairs.length >= MAX_SENTENCES) break;
    if (originalSet.has(sentence)) continue; // unchanged sentence

    const length = [...sentence].length;
    const maxDistance = Math.max(2, Math.floor(length * 0.5));

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < available.length; i += 1) {
      const distance = levenshtein(available[i], sentence);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (bestIndex !== -1 && bestDistance > 0 && bestDistance <= maxDistance) {
      pairs.push({ attempted: available[bestIndex], correct: sentence });
      available.splice(bestIndex, 1);
    }
  }

  return pairs;
}
