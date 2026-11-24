// Minimal LCS diff with no dependency — inputs here are a sentence or two, so
// O(n*m) is fine. Two granularities:
// - diffChars: character-level, for spelling-style checks (SpellingDrill,
//   the review answer check) where single-letter mistakes matter.
// - diffWords: word-level for whitespace-delimited scripts, falling back to
//   one token per character for scripts without spaces (Japanese, Chinese,
//   Thai). Used for sentence corrections (FeedbackPanel, the retry check,
//   HistoryView) so a changed word is highlighted whole instead of being
//   split into scattered letter fragments.

export type DiffOp = "same" | "added" | "removed";

export interface DiffChunk {
  op: DiffOp;
  text: string;
}

function diffTokens(a: string[], b: string[]): DiffChunk[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const chunks: DiffChunk[] = [];
  function push(op: DiffOp, text: string) {
    const last = chunks[chunks.length - 1];
    if (last && last.op === op) last.text += text;
    else chunks.push({ op, text });
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed", a[i]);
      i += 1;
    } else {
      push("added", b[j]);
      j += 1;
    }
  }
  while (i < n) {
    push("removed", a[i]);
    i += 1;
  }
  while (j < m) {
    push("added", b[j]);
    j += 1;
  }

  return chunks;
}

export function diffChars(before: string, after: string): DiffChunk[] {
  return diffTokens([...before], [...after]);
}

// Scripts written without spaces between words: tokenized per character.
const UNSPACED = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー`;
const TOKEN_RE = new RegExp(
  String.raw`(?:(?![${UNSPACED}])[\p{L}\p{M}\p{N}'’])+|\s+|[\s\S]`,
  "gu",
);

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function diffWords(before: string, after: string): DiffChunk[] {
  return diffTokens(tokenize(before), tokenize(after));
}
