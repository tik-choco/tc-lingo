// URL hash routing: deep links into a tab. Kept as a small set of
// pure/DOM-adjacent functions (no framework state) so app.tsx can wire it
// into useState / useEffect however it likes. Same pattern as tc-books.
//
// Recognized shapes: #/practice  #/review  #/cards  #/history  #/settings
import type { MainTab } from "../types";

export interface HashState {
  tab: MainTab | null;
}

const EMPTY_STATE: HashState = { tab: null };

function isMainTab(value: string): value is MainTab {
  return (
    value === "practice" ||
    value === "review" ||
    value === "cards" ||
    value === "history" ||
    value === "settings"
  );
}

/** Parses a location.hash-shaped string ("#..." or ""). Pure function. */
export function parseHash(hash: string): HashState {
  if (!hash || hash === "#") return EMPTY_STATE;
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body.startsWith("/")) return EMPTY_STATE;
  const parts = body.slice(1).split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return EMPTY_STATE;
  const [tabPart] = parts;
  return isMainTab(tabPart) ? { tab: tabPart } : EMPTY_STATE;
}

export function readHash(): HashState {
  return parseHash(location.hash);
}

/** Updates the URL hash without pushing a history entry. */
export function writeHash(tab: MainTab): void {
  const url = `${location.pathname}${location.search}#/${tab}`;
  history.replaceState(null, "", url);
}

/** Subscribes to hashchange (e.g. back/forward navigation). Returns an
 * unsubscribe function. */
export function onHashChange(cb: (state: HashState) => void): () => void {
  function handler() {
    cb(readHash());
  }
  addEventListener("hashchange", handler);
  return () => removeEventListener("hashchange", handler);
}
