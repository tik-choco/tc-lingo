import type { Card } from "../types";
import { loadJson, newId, saveJson, saveJsonBatch, storageKey, validId } from "./storage";
import type { JsonWrite } from "./storage";

// Grading writes this device's counters. Vault backs up each device separately.
export const REVIEW_ACTIVITY_STORAGE = "review-activity-v1";
export const REVIEW_ACTIVITY_REMOTE_STORAGE = "review-activity-remote-v1";
export const DEVICE_ID_STORAGE = "device-id-v1";
const RETENTION_DAYS = 400;
const MAX_REMOTE_DEVICES = 64;

export interface ReviewActivity {
  v: 1;
  days: Record<string, Record<string, number>>;
}

export type ReviewActivityByDevice = Record<string, ReviewActivity["days"]>;

type SeedCard = Pick<Card, "lastReviewedAt" | "language">;

export function loadDeviceId(): string {
  const saved = loadJson<unknown>(DEVICE_ID_STORAGE, null);
  if (validId(saved)) return saved;
  const id = newId();
  saveJson(DEVICE_ID_STORAGE, id, { throwOnError: true });
  return id;
}

export function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function emptyActivity(): ReviewActivity {
  return { v: 1, days: Object.create(null) as ReviewActivity["days"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key;
}

export function isReviewCount(count: unknown): count is number {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
}

function sanitizeDays(raw: unknown, first = ""): ReviewActivity["days"] {
  const { days } = emptyActivity();
  if (!isRecord(raw)) return days;
  for (const [key, counts] of Object.entries(raw)) {
    if (key < first || !isDateKey(key) || !isRecord(counts)) continue;
    const valid = emptyLanguageCounts();
    for (const [language, count] of Object.entries(counts)) {
      if (isReviewCount(count)) valid[language] = count;
    }
    if (Object.keys(valid).length) days[key] = valid;
  }
  return days;
}

function readActivity(): ReviewActivity | null {
  const raw = loadJson<unknown>(REVIEW_ACTIVITY_STORAGE, undefined);
  if (raw === undefined) {
    try {
      // Only an absent key triggers seeding. loadJson also falls back on invalid JSON.
      if (localStorage.getItem(storageKey(REVIEW_ACTIVITY_STORAGE)) === null) return null;
    } catch {
      return emptyActivity();
    }
  }
  return isRecord(raw) && raw.v === 1 ? { v: 1, days: sanitizeDays(raw.days) } : emptyActivity();
}

function emptyLanguageCounts(): Record<string, number> {
  // Language names are arbitrary strings, including legacy unassigned cards ("").
  return Object.create(null) as Record<string, number>;
}

function increment(activity: ReviewActivity, day: string, language: string): void {
  const counts = activity.days[day] ??= emptyLanguageCounts();
  counts[language] = Math.min((counts[language] ?? 0) + 1, Number.MAX_SAFE_INTEGER);
}

function seedActivity(cards: readonly SeedCard[]): ReviewActivity {
  const activity = emptyActivity();
  for (const { lastReviewedAt, language } of cards) {
    if (!lastReviewedAt) continue;
    const date = new Date(lastReviewedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const key = localDateKey(date);
    if (isDateKey(key)) increment(activity, key, language);
  }
  return activity;
}

function retentionStart(now: Date): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  return localDateKey(cutoff);
}

function pruneActivity(activity: ReviewActivity, now: Date): void {
  const first = retentionStart(now);
  for (const key of Object.keys(activity.days)) {
    if (key < first) delete activity.days[key];
  }
}

/** Pass a lazy card loader when opening History to seed and persist a missing log. */
export function loadReviewActivity(loadCards?: () => readonly SeedCard[], now = new Date()): ReviewActivity {
  const saved = readActivity();
  if (saved) return saved;
  if (!loadCards) return emptyActivity();
  const activity = seedActivity(loadCards());
  pruneActivity(activity, now);
  saveJson(REVIEW_ACTIVITY_STORAGE, activity);
  return activity;
}

/** Prepare the next log for the caller's card-write batch, including any initial seed. */
export function nextReviewActivity(cards: readonly SeedCard[], language: string, now: Date): ReviewActivity {
  const activity = readActivity() ?? seedActivity(cards);
  increment(activity, localDateKey(now), language);
  pruneActivity(activity, now);
  return activity;
}

function sanitizeDevices(raw: unknown, ownId: unknown, now: Date): ReviewActivityByDevice {
  const devices = Object.create(null) as ReviewActivityByDevice;
  if (!isRecord(raw)) return devices;
  const first = retentionStart(now);
  let remoteCount = 0;
  for (const id of Object.keys(raw).sort()) {
    if (!validId(id) || (id !== ownId && remoteCount >= MAX_REMOTE_DEVICES)) continue;
    const days = sanitizeDays(raw[id], first);
    if (!Object.keys(days).length) continue;
    devices[id] = days;
    if (id !== ownId) remoteCount++;
  }
  return devices;
}

function remoteDevices(raw: unknown, ownId: unknown, now: Date): ReviewActivityByDevice {
  return sanitizeDevices(isRecord(raw) && raw.v === 1 ? raw.devices : undefined, ownId, now);
}

/** Merge counters into a sanitized day map and report whether it changed. */
function combineDays(
  days: ReviewActivity["days"],
  incoming: ReviewActivity["days"],
  combine = Math.max,
): boolean {
  let changed = false;
  for (const [day, counts] of Object.entries(incoming)) {
    const target = days[day] ??= emptyLanguageCounts();
    for (const [language, count] of Object.entries(counts)) {
      const next = combine(target[language] ?? 0, count);
      if (next !== target[language]) {
        target[language] = next;
        changed = true;
      }
    }
  }
  return changed;
}

export function loadAllReviewDays(): ReviewActivity["days"] {
  const ownId = loadJson<unknown>(DEVICE_ID_STORAGE, null);
  const days = loadReviewActivity().days;
  const devices = remoteDevices(loadJson<unknown>(REVIEW_ACTIVITY_REMOTE_STORAGE, null), ownId, new Date());
  if (validId(ownId) && devices[ownId]) {
    combineDays(days, devices[ownId]);
    delete devices[ownId];
  }
  for (const remote of Object.values(devices)) {
    combineDays(days, remote, (own, other) => own + other);
  }
  return days;
}

export function loadReviewActivityForVault(): ReviewActivityByDevice {
  const now = new Date();
  const { days } = loadReviewActivity();
  const hasOwnCounts = Object.keys(days).length > 0;
  const id = hasOwnCounts ? loadDeviceId() : loadJson<unknown>(DEVICE_ID_STORAGE, null);
  const devices = remoteDevices(loadJson<unknown>(REVIEW_ACTIVITY_REMOTE_STORAGE, null), id, now);
  if (hasOwnCounts && validId(id)) combineDays(devices[id] ??= emptyActivity().days, days);
  return devices;
}

export function applyReviewActivityFromVault(incoming: ReviewActivityByDevice): void {
  if (!Object.values(incoming).some((days) => Object.values(days).some((counts) => Object.keys(counts).length))) return;
  const id = loadDeviceId();
  const now = new Date();
  const rawRemote = loadJson<unknown>(REVIEW_ACTIVITY_REMOTE_STORAGE, null);
  const devices = remoteDevices(rawRemote, id, now);
  const saved = readActivity();
  const activity = saved ?? emptyActivity();
  let ownChanged = devices[id] ? combineDays(activity.days, devices[id]) : false;
  delete devices[id];
  for (const [deviceId, days] of Object.entries(incoming)) {
    if (deviceId === id) ownChanged = combineDays(activity.days, days) || ownChanged;
    else combineDays(devices[deviceId] ??= emptyActivity().days, days);
  }

  const writes: JsonWrite[] = [];
  // A restored device starts with zero own reviews. Seeding from restored cards
  // would count some of the remote reviews a second time.
  if (!saved || ownChanged) writes.push({ name: REVIEW_ACTIVITY_STORAGE, value: activity });
  const remote = sanitizeDevices(devices, id, now);
  if (rawRemote !== null || Object.keys(remote).length) {
    writes.push({ name: REVIEW_ACTIVITY_REMOTE_STORAGE, value: { v: 1, devices: remote } });
  }
  saveJsonBatch(writes, { source: "vault", throwOnError: true });
}
