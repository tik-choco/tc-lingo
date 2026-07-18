// Receiving side of the `lingo-card-inbox` sharedBus topic (tc-translate →
// tc-lingo, translation/explain history → SRS cards). See
// tc-docs/drafts/lingo-card-inbox-v1.md for the full design and
// protocol/docs/data-contracts/docs/SHARED_BUS.md's `lingo-card-inbox`
// section for the wire contract this module implements the receiver half of.
//
// Shape: like every other family inbox (tc-storage's appDriveInbox.ts /
// appBooksBackupInbox.ts, tc-note's noteInbox.ts), the sharedBus record's
// `meta.items` is a lightweight, CID-free rolling list (senders publish it
// directly, no mistlib needed to read it), while each item's actual payload
// lives at a separate mistlib CID this module resolves lazily (on demand,
// not eagerly for every item — see resolvePayload). Idempotency is tracked
// separately from the item list, in `tc-lingo:card-inbox-state-v1`, so a
// re-published item (sender edits/retries) doesn't re-surface once handled.
//
// Failure handling mirrors the rest of the family
// (storage-drive-inbox #16 / note-doc-index #19): a failure to even fetch
// the payload (mistlib init, storage_get miss — e.g. the CID hasn't finished
// replicating, or was published before this browser ever loaded mistlib) is
// *transient* — the item stays pending and the UI can offer a retry. A
// payload that fetches fine but doesn't match `LingoCardPayloadV1`'s shape
// (foreign data, a corrupt write, a future incompatible version) is
// *permanent* — retrying would produce the same non-match forever, so it's
// recorded as `dismissed` and drops out of the inbox like a user-dismissed
// item would.
import { loadJson, saveJson, subscribeStorage } from "./storage";
import { readShared, subscribeShared } from "./sharedBus";
import { storageGetJson } from "./mistStorage";

const TOPIC = "lingo-card-inbox";
const STATE_NAME = "card-inbox-state-v1";

/** Idempotency record cap — old entries are trimmed once this is exceeded
 * (see trimDone). Generous relative to the sender's own 50-item rolling
 * window so a learner who leaves the inbox unread for a long stretch still
 * has every item's status remembered. */
const MAX_DONE_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Wire types (LingoCardInboxItem / LingoCardPayloadV1) — foreign data (from
// tc-translate, a different app/codebase), so every field is defensively
// type-guarded before use. Mirrors this app's existing loadJson + type-guard
// convention (see lib/cards.ts's isCard, lib/topics.ts's isTopic).

export interface LingoCardInboxItem {
  /** Stable id = the tc-translate history item's id. This app's idempotency
   * key (see `done` below) — a re-published item with the same id is a
   * resend, not a new item. */
  id: string;
  kind: "translate" | "explain";
  /** languageOptions canonical English name, e.g. "Japanese". */
  targetLanguage: string;
  /** First ~200 chars, shown in the collapsed inbox row before the payload
   * (and its CID round-trip) is ever fetched. */
  sourcePreview: string;
  /** mistlib storage_add CID for the LingoCardPayloadV1 this item points to. */
  cid: string;
  /** ISO 8601. */
  sentAt: string;
}

function isLingoCardInboxItem(value: unknown): value is LingoCardInboxItem {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id !== "" &&
    (r.kind === "translate" || r.kind === "explain") &&
    typeof r.targetLanguage === "string" &&
    typeof r.sourcePreview === "string" &&
    typeof r.cid === "string" &&
    r.cid !== "" &&
    typeof r.sentAt === "string"
  );
}

interface LingoCardInboxMetaV1 {
  v: 1;
  items: LingoCardInboxItem[];
}

function isLingoCardInboxMetaV1(value: unknown): value is LingoCardInboxMetaV1 {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.v === 1 && Array.isArray(r.items);
}

export interface LingoCardTranslationV1 {
  tone: string;
  text: string;
  reading?: string;
  pinyin?: string;
}

function isLingoCardTranslationV1(value: unknown): value is LingoCardTranslationV1 {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tone === "string" &&
    typeof r.text === "string" &&
    (r.reading === undefined || typeof r.reading === "string") &&
    (r.pinyin === undefined || typeof r.pinyin === "string")
  );
}

export interface LingoCardVocabularyV1 {
  word: string;
  reading?: string;
  meaning: string;
  note?: string;
}

function isLingoCardVocabularyV1(value: unknown): value is LingoCardVocabularyV1 {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.word === "string" &&
    typeof r.meaning === "string" &&
    (r.reading === undefined || typeof r.reading === "string") &&
    (r.note === undefined || typeof r.note === "string")
  );
}

export interface LingoCardGrammarPointV1 {
  pattern: string;
  explanation: string;
  example?: string;
}

function isLingoCardGrammarPointV1(value: unknown): value is LingoCardGrammarPointV1 {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.pattern === "string" &&
    typeof r.explanation === "string" &&
    (r.example === undefined || typeof r.example === "string")
  );
}

/** The shape a `LingoCardInboxItem.cid` points to (mistlib storage_add'd by
 * the sender as plain JSON — see the sharedBus topic doc for why this is
 * unencrypted). A dedicated, versioned contract type, deliberately not
 * tc-translate's internal history-item shape. */
export interface LingoCardPayloadV1 {
  v: 1;
  sourceText: string;
  translations: LingoCardTranslationV1[];
  vocabulary?: LingoCardVocabularyV1[];
  grammarPoints?: LingoCardGrammarPointV1[];
  notes: string[];
}

function isLingoCardPayloadV1(value: unknown): value is LingoCardPayloadV1 {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.sourceText === "string" &&
    Array.isArray(r.translations) &&
    r.translations.every(isLingoCardTranslationV1) &&
    (r.vocabulary === undefined || (Array.isArray(r.vocabulary) && r.vocabulary.every(isLingoCardVocabularyV1))) &&
    (r.grammarPoints === undefined ||
      (Array.isArray(r.grammarPoints) && r.grammarPoints.every(isLingoCardGrammarPointV1))) &&
    Array.isArray(r.notes) &&
    r.notes.every((n) => typeof n === "string")
  );
}

// ---------------------------------------------------------------------------
// Idempotency state: tc-lingo:card-inbox-state-v1.

type InboxItemStatus = "imported" | "dismissed";

interface CardInboxState {
  v: 1;
  done: Record<string, InboxItemStatus>;
}

function isCardInboxState(value: unknown): value is CardInboxState {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || r.done === null || typeof r.done !== "object" || Array.isArray(r.done)) return false;
  return Object.values(r.done as Record<string, unknown>).every((s) => s === "imported" || s === "dismissed");
}

const emptyState: CardInboxState = { v: 1, done: {} };

function loadState(): CardInboxState {
  const raw = loadJson<unknown>(STATE_NAME, null);
  return isCardInboxState(raw) ? raw : emptyState;
}

function saveState(state: CardInboxState): void {
  saveJson(STATE_NAME, state);
}

/** Drops the oldest entries once `done` exceeds MAX_DONE_ENTRIES. Relies on
 * JS objects preserving string-key insertion order — every id here is a
 * tc-translate history item id (uuid-shaped, never an array-index-like
 * numeric string), so that guarantee holds. "Oldest" means "earliest
 * recorded", not sender `sentAt`: re-marking an id (shouldn't normally
 * happen — see markImported/dismiss) would bump it to the back, which is a
 * fine tie-break for a cap that exists purely to bound growth. */
function trimDone(done: Record<string, InboxItemStatus>): Record<string, InboxItemStatus> {
  const entries = Object.entries(done);
  if (entries.length <= MAX_DONE_ENTRIES) return done;
  return Object.fromEntries(entries.slice(entries.length - MAX_DONE_ENTRIES));
}

function setDone(id: string, status: InboxItemStatus): void {
  const state = loadState();
  saveState({ v: 1, done: trimDone({ ...state.done, [id]: status }) });
}

/** Records `id` as imported (cards were added from it). Idempotent — safe to
 * call again for the same id. */
export function markImported(id: string): void {
  setDone(id, "imported");
}

/** Records `id` as dismissed — either the learner discarded it, or (see
 * resolvePayload) its payload permanently failed to validate. */
export function dismiss(id: string): void {
  setDone(id, "dismissed");
}

// ---------------------------------------------------------------------------
// Item list.

/** Every inbox item the sender currently has published, still pending (not
 * yet `imported`/`dismissed`), defensively filtered. Reads localStorage
 * fresh each call — pair with subscribeInbox for a live view, same pattern
 * as lib/cards.ts's loadCards/subscribeCards. */
export function loadInboxItems(): LingoCardInboxItem[] {
  const record = readShared(TOPIC);
  if (!record) return [];
  const meta: unknown = record.meta;
  if (!isLingoCardInboxMetaV1(meta)) return [];
  const done = loadState().done;
  return meta.items.filter(isLingoCardInboxItem).filter((item) => !(item.id in done));
}

/** Subscribes to both new/updated sender publications (sharedBus) and local
 * done-state changes (markImported/dismiss, via lib/storage.ts's change
 * event) — either can change what loadInboxItems() returns. Returns an
 * unsubscribe function. */
export function subscribeInbox(cb: () => void): () => void {
  const unsubscribeShared = subscribeShared(TOPIC, () => cb());
  const unsubscribeLocal = subscribeStorage(cb);
  return () => {
    unsubscribeShared();
    unsubscribeLocal();
  };
}

// ---------------------------------------------------------------------------
// Payload resolution.

export type PayloadResolution =
  | { kind: "resolved"; payload: LingoCardPayloadV1 }
  | { kind: "transient" }
  | { kind: "permanent" };

/**
 * Fetches and validates the payload for `item`. Never throws.
 *
 * - mistlib init / storage_get failure -> `{ kind: "transient" }`, `done` is
 *   left untouched so the item stays in the inbox and the caller can offer a
 *   retry (e.g. the CID hasn't replicated to this browser's mistlib node
 *   yet).
 * - fetched but fails the LingoCardPayloadV1 type guard -> `{ kind:
 *   "permanent" }`, and this function itself calls dismiss(item.id) (no
 *   separate step for callers to remember) since retrying bytes that don't
 *   parse as this contract will never start parsing on a later attempt.
 * - otherwise -> `{ kind: "resolved", payload }`.
 */
export async function resolvePayload(item: LingoCardInboxItem): Promise<PayloadResolution> {
  let raw: unknown;
  try {
    raw = await storageGetJson<unknown>(item.cid);
  } catch {
    return { kind: "transient" };
  }
  if (!isLingoCardPayloadV1(raw)) {
    dismiss(item.id);
    return { kind: "permanent" };
  }
  return { kind: "resolved", payload: raw };
}
