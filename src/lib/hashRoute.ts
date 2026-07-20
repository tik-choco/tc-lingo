// URL hash routing: deep links into a tab. Kept as a small set of
// pure/DOM-adjacent functions (no framework state) so app.tsx can wire it
// into useState / useEffect however it likes. Same pattern as tc-books.
//
// Recognized shapes: #/practice  #/reading  #/talk  #/review  #/cards
// #/history  #/settings  #/sync/<roomId> (device-to-device sync invite link —
// resolves to the settings tab with syncRoomId set; see lib/sync/types.ts)
import type { MainTab } from "../types";

export interface HashState {
  tab: MainTab | null;
  /** Set only for a `#/sync/<roomId>` deep link — always paired with
   * `tab: "settings"`. See lib/sync/session.ts's requestSyncJoin. */
  syncRoomId?: string;
}

const EMPTY_STATE: HashState = { tab: null };

function isMainTab(value: string): value is MainTab {
  return (
    value === "practice" ||
    value === "reading" ||
    value === "talk" ||
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
  if (tabPart === "sync") {
    const roomId = parts.slice(1).join("/");
    return roomId ? { tab: "settings", syncRoomId: roomId } : EMPTY_STATE;
  }
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
