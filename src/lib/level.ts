// Automatic proficiency estimation per target language, driving level-aware
// generation (reading passages, conversation partner, topic suggestions,
// practice feedback/retry, mistake-card extraction, grammar explanations).
//
// Model: every corrected output (practice feedback, talk reply) contributes
// one sample — a 0..1 "accuracy" derived from the character-diff between the
// learner's text and the correction (1 = no correction needed). Samples feed
// an EMA per language, and the score maps onto a coarse CEFR band once
// enough samples exist. Deliberately cheap and deterministic (reuses
// lib/diff.ts, no LLM call); the band only steers prompt wording, so rough
// calibration is fine. The settings screen can pin a manual override.
// Persistence key: tc-lingo:levels-v1.
import type { CefrBand, LanguageLevelRecord } from "../types";
import { diffChars } from "./diff";
import { loadJson, saveJson, subscribeStorage } from "./storage";

const STORAGE_NAME = "levels-v1";

/** Below this many samples the estimate is withheld ("" band) — a couple of
 * lucky sentences shouldn't relabel a beginner as B2. */
const MIN_SAMPLES = 3;

/** EMA weight of the newest sample: recent output dominates, so the estimate
 * tracks improvement within a few sessions instead of averaging forever. */
const EMA_ALPHA = 0.2;

export const CEFR_BANDS: CefrBand[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

function isCefrBand(value: unknown): value is CefrBand {
  return typeof value === "string" && (CEFR_BANDS as string[]).includes(value);
}

function isLevelRecord(value: unknown): value is LanguageLevelRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.language === "string" &&
    typeof r.score === "number" &&
    Number.isFinite(r.score) &&
    typeof r.samples === "number" &&
    Number.isFinite(r.samples) &&
    (r.override === "" || isCefrBand(r.override)) &&
    typeof r.updatedAt === "string"
  );
}

export function loadLevels(): LanguageLevelRecord[] {
  const raw = loadJson<unknown[]>(STORAGE_NAME, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLevelRecord);
}

function saveLevels(records: LanguageLevelRecord[]): void {
  saveJson(STORAGE_NAME, records);
}

export function subscribeLevels(cb: () => void): () => void {
  return subscribeStorage(cb);
}

export function getLevelRecord(language: string): LanguageLevelRecord | null {
  return loadLevels().find((r) => r.language === language) ?? null;
}

/** 0..1 accuracy of one output sample: 1 when no correction was needed,
 * otherwise 1 minus the changed-character share of the diff. */
function sampleAccuracy(original: string, corrected: string): number {
  const before = original.trim();
  const after = corrected.trim();
  if (!after || before === after) return 1;
  let changed = 0;
  let total = 0;
  for (const chunk of diffChars(before, after)) {
    const len = [...chunk.text].length;
    total += len;
    if (chunk.op !== "same") changed += len;
  }
  if (total === 0) return 1;
  return Math.max(0, 1 - changed / total);
}

/** Feeds one practice/talk output (and its correction, "" when none was
 * needed) into the language's running estimate. */
export function recordOutputSample(language: string, original: string, corrected: string): void {
  const lang = language.trim();
  if (!lang || !original.trim()) return;
  const accuracy = sampleAccuracy(original, corrected);
  const records = loadLevels();
  const existing = records.find((r) => r.language === lang);
  const updatedAt = new Date().toISOString();
  if (existing) {
    existing.score = existing.samples === 0 ? accuracy : existing.score * (1 - EMA_ALPHA) + accuracy * EMA_ALPHA;
    existing.samples += 1;
    existing.updatedAt = updatedAt;
  } else {
    records.push({ language: lang, score: accuracy, samples: 1, override: "", updatedAt });
  }
  saveLevels(records);
}

/** Score → coarse CEFR band. Thresholds are heuristic: heavily corrected
 * output sits low, near-flawless output sits high. */
function bandForScore(score: number): CefrBand {
  if (score < 0.5) return "A1";
  if (score < 0.65) return "A2";
  if (score < 0.78) return "B1";
  if (score < 0.88) return "B2";
  if (score < 0.95) return "C1";
  return "C2";
}

/** The automatically estimated band, or "" while there aren't enough samples. */
export function computedBand(record: LanguageLevelRecord | null): CefrBand | "" {
  if (!record || record.samples < MIN_SAMPLES) return "";
  return bandForScore(record.score);
}

/** The band generation should target: a manual override wins, else the
 * automatic estimate, else "" (unknown — callers fall back to a generic
 * "keep it accessible" framing). */
export function effectiveBand(language: string): CefrBand | "" {
  const record = getLevelRecord(language);
  if (record && record.override) return record.override;
  return computedBand(record);
}

/** Pins (or with "" releases) a manual level override for a language. */
export function setLevelOverride(language: string, band: CefrBand | ""): void {
  const lang = language.trim();
  if (!lang) return;
  const records = loadLevels();
  const existing = records.find((r) => r.language === lang);
  if (existing) {
    existing.override = band;
    existing.updatedAt = new Date().toISOString();
  } else {
    records.push({ language: lang, score: 0, samples: 0, override: band, updatedAt: new Date().toISOString() });
  }
  saveLevels(records);
}

/** English prompt fragment steering generation to the learner's level, or ""
 * when the level is still unknown (callers keep their generic wording then).
 * Not user-visible — prompts are English throughout this codebase. */
export function levelInstruction(language: string): string {
  const band = effectiveBand(language);
  if (!band) return "";
  return ` The learner's estimated CEFR proficiency in ${language} is ${band}. Calibrate your ${language} to that level — vocabulary, sentence length, and grammar pitched just slightly above it ("i+1") so the learner is stretched but never overwhelmed.`;
}
