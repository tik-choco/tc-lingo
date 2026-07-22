// Aligns a Japanese card's whole-string reading against its front text to
// produce per-kanji-run furigana, so ruby annotates just the kanji instead of
// smearing one reading over a front that mixes kanji and kana. A flat
// "whole front, whole reading" ruby looks wrong/misaligned whenever front's
// okurigana or conjugation isn't verbatim in reading (e.g. front is a
// conjugated phrase like 養ってくれる but reading was generated for the
// dictionary form 養う) — see components/CardFront.tsx.
// 一-鿿: CJK Unified Ideographs (kanji); 々: kanji iteration mark (々).
const KANJI_RUN = /[一-鿿々]+/;
const SEGMENT_RE = /[一-鿿々]+|[^一-鿿々]+/g;

// ァ-ヶ: full-width katakana ァ-ヶ; hiragana sits exactly 0x60 below.
function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export interface FuriganaSegment {
  text: string;
  /** Reading for this segment, or null for a plain (non-kanji) segment that
   * should render as-is with no ruby. */
  furigana: string | null;
}

/** Splits `front` into kanji/non-kanji runs and aligns each kanji run against
 * the matching slice of `reading`, using the surrounding non-kanji runs
 * (kana, which reads as itself) as anchors. Returns null — meaning "don't
 * attempt furigana, fall back to plain text" — when `front` has no kanji to
 * annotate, or when `reading` doesn't actually contain every non-kanji run in
 * order (the alignment doesn't hold, most often because `reading` was
 * generated for a different conjugation/form than `front`). Never guesses: an
 * inconsistency means no furigana rather than a misleading one. */
export function computeFurigana(front: string, reading: string): FuriganaSegment[] | null {
  if (!front || !reading || !KANJI_RUN.test(front)) return null;

  const rawSegments = front.match(SEGMENT_RE);
  if (!rawSegments) return null;
  const segments = rawSegments.map((text) => ({ text, isKanji: KANJI_RUN.test(text) }));

  const result: FuriganaSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (!seg.isKanji) {
      const normalized = katakanaToHiragana(seg.text);
      if (reading.slice(cursor, cursor + normalized.length) !== normalized) return null;
      result.push({ text: seg.text, furigana: null });
      cursor += normalized.length;
      continue;
    }

    const next = segments[i + 1];
    if (next) {
      const anchor = katakanaToHiragana(next.text);
      const pos = reading.indexOf(anchor, cursor);
      if (pos <= cursor) return null;
      result.push({ text: seg.text, furigana: reading.slice(cursor, pos) });
      cursor = pos;
    } else {
      if (cursor >= reading.length) return null;
      result.push({ text: seg.text, furigana: reading.slice(cursor) });
      cursor = reading.length;
    }
  }

  return cursor === reading.length ? result : null;
}
