// Grammar explanation ("文法解説"): an on-demand, explicit breakdown of the
// grammar patterns/structures in one target-language sentence. Closes the
// 理解 (explicit understanding) step of CLAUDE.md's core loop
// (理解→インプット→やり取り→アウトプット→定着) — the rest of the app corrects
// output and lets the learner re-use it, but never proactively explains
// *why* a sentence is built the way it is. Same spirit as tc-translate's
// explain feature. One-shot JSON call via lib/llm.ts's chatJson, same shape
// as the sibling LLM-call modules (lib/reading.ts, lib/conversation.ts).
// Also folds in lib/level.ts's levelInstruction so how deep an explanation
// goes matches the learner's estimated CEFR level; since the level band can
// change over time, it's part of the response cache key below, not just the
// prompt.
import { t } from "../i18n";
import type { LlmConnection } from "./llmConnection";
import { chatJson } from "./llm";
import { effectiveBand, levelInstruction } from "./level";
import { extractJson } from "./parse";

/** One grammar point surfaced for a sentence: the pattern/form itself, a
 * concise explanation in the learner's native language, and a fresh example
 * reusing the same pattern. Local to this module — deliberately not part of
 * types.ts, since it's ephemeral LLM output, not persisted domain data (see
 * CLAUDE.md's "v2/backlog" note on what belongs in the domain layer). */
export interface GrammarPoint {
  pattern: string;
  explanation: string;
  example: string;
}

// Raw localStorage (not lib/storage.ts) on purpose: this is a derived cache
// keyed by sentence content, not user data worth a change event — same
// rationale as i18n/index.ts's UI-messages overlay cache.
const CACHE_KEY = "tc-lingo-grammar-cache-v1";

/** Oldest entries fall off past this so the cache doesn't grow forever —
 * generous enough that a normal session's worth of reviewed/corrected
 * sentences all stay warm. */
const CACHE_LIMIT = 50;

interface CacheEntry {
  key: string;
  points: GrammarPoint[];
}

// djb2 string hash, same algorithm as i18n/index.ts's sourceHash — good
// enough for a cache key, not for anything security-sensitive.
function hash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 33 + value.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// `band` (the CEFR level generation was calibrated to, "" when unknown) is
// folded into the key alongside the language pair and sentence — otherwise a
// level change (auto re-estimate or manual override) would keep serving an
// explanation cached from a different calibration.
function cacheKeyFor(nativeLanguage: string, targetLanguage: string, band: string, sentence: string): string {
  return hash(`${nativeLanguage}|${targetLanguage}|${band}|${sentence}`);
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.key === "string" && Array.isArray(r.points);
}

function loadCache(): CacheEntry[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCacheEntry) : [];
  } catch {
    return [];
  }
}

function saveCache(entries: CacheEntry[]): void {
  try {
    // FIFO cap: drop the oldest entries once past the limit.
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries.slice(-CACHE_LIMIT)));
  } catch {
    // Caching is best-effort — a full/unavailable localStorage just means
    // every explanation re-fetches instead of failing outright.
  }
}

function readCache(key: string): GrammarPoint[] | null {
  const entry = loadCache().find((e) => e.key === key);
  return entry ? entry.points : null;
}

function writeCache(key: string, points: GrammarPoint[]): void {
  const entries = loadCache().filter((e) => e.key !== key);
  entries.push({ key, points });
  saveCache(entries);
}

function isGrammarPoint(value: unknown): value is GrammarPoint {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.pattern === "string" && typeof r.explanation === "string" && typeof r.example === "string";
}

/** Defensive parse, style of parse.ts's parse* helpers: throws a localized
 * Error only when the response is genuinely unusable (not even a points
 * array to work with). A syntactically valid but *empty* points array is
 * NOT an error — a trivially simple sentence legitimately has nothing worth
 * explaining, and the caller shows an i18n'd "nothing notable" message
 * instead of an error state for that case. */
function parseGrammarPoints(content: string): GrammarPoint[] {
  const parsed = extractJson(content);
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(record?.points) ? (record.points as unknown[]) : null;
  if (list === null) throw new Error(t("grammar-error-parse"));
  return list.filter(isGrammarPoint);
}

/**
 * Explains the 1-4 grammar patterns/structures a learner most needs to
 * understand a single target-language sentence — verb forms/conjugations,
 * particles/case markers, clause structure, set constructions/idioms;
 * skips trivia, and is calibrated to the learner's estimated CEFR level (see
 * lib/level.ts). Identical (nativeLanguage, targetLanguage, level band,
 * sentence) combinations are served from a capped localStorage cache instead
 * of re-billing the LLM. May legitimately resolve to an empty array (nothing notable) —
 * that is not an error condition, see parseGrammarPoints.
 */
export async function requestGrammarExplanation(params: {
  connection: LlmConnection;
  targetLanguage: string;
  nativeLanguage: string;
  sentence: string;
}): Promise<GrammarPoint[]> {
  const sentence = params.sentence.trim();
  if (!sentence) return [];

  const band = effectiveBand(params.targetLanguage);
  const key = cacheKeyFor(params.nativeLanguage, params.targetLanguage, band, sentence);
  const cached = readCache(key);
  if (cached) return cached;

  const content = await chatJson(
    params.connection,
    `You are TC Lingo's grammar coach. The learner is studying ${params.targetLanguage} (native language: ${params.nativeLanguage}). Given one ${params.targetLanguage} sentence, identify the 1 to 4 grammar patterns or structures a learner most needs to understand in order to fully parse it — verb forms/conjugations, particles/case markers, clause structure, set constructions/idioms. Skip trivial vocabulary and anything not structurally interesting; if the sentence is trivially simple with nothing worth explaining, return an empty list. For each pattern, return: "pattern" (the pattern name or form itself, written in ${params.targetLanguage}, with a short ${params.nativeLanguage} gloss in parentheses where that helps identify it), "explanation" (a concise explanation of how/why it's used here, written in ${params.nativeLanguage}), "example" (one NEW short ${params.targetLanguage} example sentence using the same pattern, with different content from the input sentence — never reuse the input sentence or its content). Return ONLY JSON: {"points": [{"pattern": string, "explanation": string, "example": string}]}.${levelInstruction(params.targetLanguage)}`,
    { sentence },
  );
  const points = parseGrammarPoints(content);
  writeCache(key, points);
  return points;
}
