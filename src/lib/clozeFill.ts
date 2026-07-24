// Derives what a cloze's blank(s) are actually asking for, so review grading
// can compare against the text that fits the DISPLAYED sentence instead of
// against `front` (a card's dictionary/base form — see types.ts's Card).
// `front` and the sentence-fitting fill can differ: "manage to" (front) vs.
// "managed to" (what the blank in "we ___ arrive..." needs). A front can also
// be a DISCONTINUOUS expression written with an ellipsis between its parts
// (e.g. "not... any"), in which case the cloze legitimately blanks each part
// separately ("I ___ have ___ questions...") — see deriveClozeGaps below.
// Nothing here touches storage — this is pure derivation over already-loaded
// card/variation text, called fresh every render from ReviewView.
import type { AnswerJudgement } from "./srs";
import { judgeAnswer } from "./srs";

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

// Meta-notation a `front` uses to denote a discontinuous expression's gap
// (e.g. "not... any"), never actual sentence content — stripped before using
// `front` as a grading/drill/diff target, since a learner can't (and
// shouldn't have to) type the ellipsis itself.
const ELLIPSIS_PATTERN = /\.{3,}|…+|・{2,}/g;

/** Strips discontinuous-expression ellipsis notation ("...", "…", "・・・")
 * out of `front` and collapses the resulting whitespace, so e.g. "not... any"
 * becomes the typable "not any". Used wherever `front` stands in as a
 * grading/drill/diff target instead of the sentence-fitting fill(s) — never
 * for the raw headword display, which should still show the original
 * notation. */
export function stripEllipsisTokens(value: string): string {
  return collapseWhitespace(value.replace(ELLIPSIS_PATTERN, " ")).trim();
}

/** All gap texts, in order, that fill a cloze's blank(s) by aligning `cloze`
 * (N blanks, so N+1 literal segments) against the sentence it was cut from.
 * Tolerates whitespace-run differences between the two (normalized before
 * comparing), but each returned gap is trimmed, not otherwise altered.
 * Segment 0 anchors at the sentence start and the last segment anchors at
 * the end; middle segments are located in order via indexOf from the
 * previous gap's end, so blanks must appear in the same order in `cloze` as
 * their fills do in `exampleSentence`. Returns null when there are no
 * blanks, a segment doesn't anchor/locate, segments are out of order, a gap
 * comes out empty, or a middle segment is itself empty (no landmark to
 * locate the boundary between two adjacent gaps) — any of which means the
 * cloze is misaligned/stale against the sentence. A middle segment that
 * occurs more than once in the still-splittable region is also rejected:
 * taking the leftmost match would silently split at the wrong spot and
 * produce a wrong-but-plausible grading target, which is worse than the
 * caller falling back to `front`. */
export function deriveClozeGaps(exampleSentence: string, cloze: string): string[] | null {
  const segments = cloze.split(/_{2,}/).map(collapseWhitespace);
  const gapCount = segments.length - 1;
  if (gapCount < 1) return null;

  const sentence = collapseWhitespace(exampleSentence);
  const first = segments[0];
  const last = segments[gapCount];
  if (sentence.length < first.length + last.length) return null;
  if (!sentence.startsWith(first) || !sentence.endsWith(last)) return null;
  const endBoundary = sentence.length - last.length;

  const gaps: string[] = [];
  let cursor = first.length;
  for (let i = 1; i <= gapCount; i++) {
    const isLast = i === gapCount;
    let boundary: number;
    if (isLast) {
      boundary = endBoundary;
    } else {
      const segment = segments[i];
      if (!segment) return null;
      boundary = sentence.indexOf(segment, cursor);
      if (boundary === -1) return null;
      const rematch = sentence.indexOf(segment, boundary + 1);
      if (rematch !== -1 && rematch + segment.length <= endBoundary) return null;
    }
    if (boundary < cursor) return null;
    const gap = sentence.slice(cursor, boundary).trim();
    if (!gap) return null;
    gaps.push(gap);
    cursor = isLast ? boundary : boundary + segments[i].length;
  }
  return gaps;
}

/** judgeClozeAnswer's verdict: the underlying AnswerJudgement (against the
 * sentence-fitting `fill`), plus whether the typed answer actually matched
 * `front` (the dictionary/base form) instead — i.e. the learner recalled the
 * right word but not the inflected form this particular blank needs. */
export type ClozeJudgement = { judgement: AnswerJudgement; lemmaMatch: boolean };

/** Grades a cloze answer against the fill the DISPLAYED blank(s) actually
 * need (see deriveClozeGaps — for a multi-blank cloze, `fill` is the gaps
 * joined with a space, matching the space-separated answer format the
 * learner was instructed to type), falling back to a "near" credit — with
 * `lemmaMatch: true` — when the typed answer instead matches the card's
 * dictionary/base `front` exactly. `front` is normalized first (ellipsis
 * notation for a discontinuous expression stripped, e.g. "not... any" ->
 * "not any") so that comparison is against something actually typable. That
 * fallback only fires when normalized `front` and `fill` actually differ;
 * when they're the same, judgeAnswer(typed, fill) already covers it. */
export function judgeClozeAnswer(typed: string, fill: string, front: string): ClozeJudgement {
  const fillJudgement = judgeAnswer(typed, fill);
  if (fillJudgement === "correct" || fillJudgement === "near") {
    return { judgement: fillJudgement, lemmaMatch: false };
  }

  const normalizedFront = stripEllipsisTokens(front);
  if (normalizedFront !== fill && judgeAnswer(typed, normalizedFront) === "correct") {
    return { judgement: "near", lemmaMatch: true };
  }

  return { judgement: "wrong", lemmaMatch: false };
}
