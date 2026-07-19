// "List TTS voices from an OpenAI-compatible endpoint" helper for the
// settings screen's TTS voice field. Ported (simplified) from tc-news's
// src/lib/voices.ts — this app doesn't have tc-news' FetchFn injection point
// or i18n-global helper, so this version takes a plain fetch and throws a
// plain (untranslated) Error; the caller (SettingsView) falls back to
// OPENAI_TTS_VOICES on any failure rather than surfacing the message.
//
// OpenAI's own API has no voices-listing endpoint, but many OpenAI-compatible
// TTS servers expose one — commonly GET {baseUrl}/audio/voices or
// {baseUrl}/voices. fetchVoices tries both, tolerating a `{ voices: [...] }`,
// `{ data: [...] }`, or plain array response shape, with entries being either
// plain strings or `{ id | name | voice }` objects.
//
// Guarded against `mist-network://` pseudo-provider base URLs (see
// lib/networkModels.ts's isNetworkProviderBaseUrl) — those aren't real HTTP
// endpoints, so callers should never reach this with one, but fetchVoices
// throws its own clear error instead of attempting (and failing) a real
// fetch() against a non-URL, per
// tc-docs/drafts/llm-settings-common-v1.md §5.3's porting checklist.
import { isNetworkProviderBaseUrl } from "./networkModels";

/** OpenAI's documented voice set, used as a UI fallback when an endpoint can't list voices. */
export const OPENAI_TTS_VOICES: string[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parses a voices response body, tolerating array/`voices`/`data` wrappers and string/object entries. */
function parseVoicesBody(body: unknown): string[] {
  const rawList = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.voices)
      ? body.voices
      : isRecord(body) && Array.isArray(body.data)
        ? body.data
        : [];

  return rawList
    .map((entry): string => {
      if (typeof entry === "string") return entry;
      if (isRecord(entry)) {
        if (typeof entry.id === "string") return entry.id;
        if (typeof entry.name === "string") return entry.name;
        if (typeof entry.voice === "string") return entry.voice;
      }
      return "";
    })
    .filter((id): id is string => id.length > 0);
}

/** Tries one candidate voices endpoint; returns null (not throw) so the caller can try the next one. */
async function tryVoicesEndpoint(url: string, apiKey: string): Promise<string[] | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch {
    return null; // network error — fall through to the next candidate endpoint
  }
  if (!response.ok) return null;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return null;
  }

  const voices = parseVoicesBody(json);
  return voices.length > 0 ? voices : null;
}

/**
 * Fetches TTS voice names from `{baseUrl}/audio/voices`, falling back to
 * `{baseUrl}/voices` if that doesn't return a usable list. Throws if neither
 * endpoint works — callers should fall back to OPENAI_TTS_VOICES.
 */
export async function fetchVoices(config: { baseUrl: string; apiKey: string }): Promise<string[]> {
  if (isNetworkProviderBaseUrl(config.baseUrl)) {
    throw new Error("AI Network presets don't expose an HTTP voice list.");
  }
  const base = config.baseUrl.replace(/\/+$/, "");
  const candidates = [`${base}/audio/voices`, `${base}/voices`];

  for (const url of candidates) {
    const voices = await tryVoicesEndpoint(url, config.apiKey);
    if (voices) return voices;
  }

  throw new Error("Failed to fetch the voice list.");
}
