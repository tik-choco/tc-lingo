// Renders a card's front + its reading: furigana ruby (kana above just the
// kanji, via lib/furigana.ts's alignment) for Japanese cards when
// settings.showReadingAids is on, otherwise the usual "front (reading)"
// parenthetical every other language already uses. Shares the same toggle as
// the sentence-level reading aid (lib/languages.ts readingAid) rather than a
// separate setting. Reading data itself is unaffected either way — this only
// changes how an existing Card.reading value is displayed (see
// lib/languages.ts readingSpec).
import { useEffect, useState } from "preact/hooks";
import { computeFurigana } from "../lib/furigana";
import { loadSettings, subscribeSettings } from "../lib/settings";

function useShowReadingAids(): boolean {
  const [show, setShow] = useState(() => loadSettings().showReadingAids);
  useEffect(() => subscribeSettings(() => setShow(loadSettings().showReadingAids)), []);
  return show;
}

export interface CardFrontProps {
  front: string;
  reading: string;
  /** The card's resolved language (`card.language || settings.activeLanguage`)
   * — furigana only ever applies to Japanese. */
  language: string;
  /** Class for the parenthetical reading span in non-ruby mode, matching
   * whatever the call site already used (card-list-reading, etc). */
  readingClassName: string;
  /** Wraps the front text in `<strong>` — for call sites that bolded the
   * front directly rather than via a CSS class on an ancestor element. */
  bold?: boolean;
}

export function CardFront({ front, reading, language, readingClassName, bold }: CardFrontProps) {
  const showReadingAids = useShowReadingAids();
  const furigana = showReadingAids && language === "Japanese" ? computeFurigana(front, reading) : null;

  if (furigana) {
    const node = (
      <>
        {furigana.map((seg, i) =>
          seg.furigana ? (
            <ruby key={i} class="card-front-ruby">
              {seg.text}
              <rt>{seg.furigana}</rt>
            </ruby>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </>
    );
    return bold ? <strong>{node}</strong> : node;
  }

  const frontNode = bold ? <strong>{front}</strong> : front;
  return (
    <>
      {frontNode}
      {reading && <span class={readingClassName}> ({reading})</span>}
    </>
  );
}
