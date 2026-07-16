// Minimal character-level LCS diff for the topic-history view (compares
// round-over-round attempts, e.g. 初回 vs 改善版). Character granularity
// (not word/space-split) so it works reasonably for languages without
// whitespace-delimited words (Japanese, Chinese) as well as ones with them.
// No new dependency — inputs here are a sentence or two, so O(n*m) is fine.

export type DiffOp = "same" | "added" | "removed";

export interface DiffChunk {
  op: DiffOp;
  text: string;
}

export function diffChars(before: string, after: string): DiffChunk[] {
  const a = [...before];
  const b = [...after];
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const chunks: DiffChunk[] = [];
  function push(op: DiffOp, ch: string) {
    const last = chunks[chunks.length - 1];
    if (last && last.op === op) last.text += ch;
    else chunks.push({ op, text: ch });
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
