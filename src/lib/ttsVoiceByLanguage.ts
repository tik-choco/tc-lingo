import { languageBcp47Tag } from "./languages";

// Per-language TTS voice override: `LingoSettings.ttsVoiceByLanguage` lets a
// learner pin a specific voice id for a given spoken language, overriding the
// single global `config.tts?.voice` (lib/llmConfig.ts) whenever the text
// being read is in that language. This matters once more than one language is
// in play (see types.ts's `LingoSettings.targetLanguages`) and/or the AI
// Network room mixes providers that each do better with a different voice for
// a given language — see tc-docs' AI Network TTS lang-hint fix
// (mistai v0.7.0, `tts_request.lang`).
//
// Keyed by BCP-47 *primary subtag* (e.g. "en", "ja", "zh" — never the full
// tag), not the canonical language name (lib/languages.ts's `languageOptions`
// values): this is the same coarse granularity `tts_request.lang` carries
// across the wire, so a provider matching an incoming request's `lang` against
// its own `ttsVoiceByLanguage` (hooks/useNetworkProvider.ts) uses the exact
// same key scheme as the consumer side resolving its own playback voice
// (hooks/useSpeech.ts) — no separate mapping table needed. One consequence:
// "Chinese (Simplified)" and "Chinese (Traditional)" share the "zh" key (both
// reduce to that primary subtag), so they can't have independently overridden
// voices — an acceptable minimal-implementation tradeoff (see the settings UI
// in SettingsView.tsx, which already collapses same-subtag languages into one
// row for this reason).
export function primaryLangSubtag(bcp47: string): string {
  return bcp47.trim().split("-")[0].toLowerCase();
}

/**
 * Resolves the per-language voice override for `lang` (a BCP-47 tag OR
 * already-bare primary subtag — this always reduces it via
 * `primaryLangSubtag` before lookup, so either form works). Returns undefined
 * when `lang` is empty, the map is absent, or no entry matches — callers fall
 * back to their own default voice in that case (see hooks/useSpeech.ts /
 * hooks/useNetworkProvider.ts).
 */
export function resolveVoiceOverride(
  ttsVoiceByLanguage: Record<string, string> | undefined,
  lang: string | undefined,
): string | undefined {
  if (!ttsVoiceByLanguage || !lang) return undefined;
  const subtag = primaryLangSubtag(lang);
  if (!subtag) return undefined;
  const voice = ttsVoiceByLanguage[subtag];
  return voice && voice.trim() ? voice : undefined;
}

/** One editable row in the settings UI's per-language voice override list:
 * `subtag` is the map key (see `primaryLangSubtag`), `languages` is every
 * canonical language name (lib/languages.ts's `languageOptions`, in
 * first-seen order) that reduces to it — usually one, but e.g. "Chinese
 * (Simplified)" and "Chinese (Traditional)" both reduce to "zh" and so share
 * a single row/override (see this module's doc comment). */
export interface LanguageVoiceRow {
  subtag: string;
  languages: string[];
}

/**
 * Groups `languages` (typically `settings.targetLanguages` plus
 * `settings.nativeLanguage`, deduped by the caller or not — this dedupes
 * languages internally too) into one row per distinct BCP-47 primary subtag,
 * preserving the order each subtag was first encountered. A language with no
 * known BCP-47 mapping (`languageBcp47Tag` returns "") is dropped — there's no
 * key to store an override under for it.
 */
export function languageVoiceRows(languages: string[]): LanguageVoiceRow[] {
  const rows: LanguageVoiceRow[] = [];
  const bySubtag = new Map<string, LanguageVoiceRow>();
  for (const language of languages) {
    const tag = languageBcp47Tag(language);
    const subtag = tag ? primaryLangSubtag(tag) : "";
    if (!subtag) continue;
    let row = bySubtag.get(subtag);
    if (!row) {
      row = { subtag, languages: [] };
      bySubtag.set(subtag, row);
      rows.push(row);
    }
    if (!row.languages.includes(language)) row.languages.push(language);
  }
  return rows;
}

// Kokoro's voice ids self-encode a language via their first letter ("af_bella"
// -> a=en, "jf_alpha" -> j=ja, "zm_yunxi" -> z=zh, ...): letter + f/m (gender)
// + "_" + name. mistai's own provider-side selectProvider heuristic carries
// the exact same prefix table (see tc-docs' AI Network TTS lang-hint fix) -
// kept in sync by hand since kokoro doesn't expose this mapping via any API.
// "a"/"b" both mean English (kokoro ships two distinct English voice packs).
const KOKORO_VOICE_ID = /^([a-z])[fm]_/i;

const KOKORO_PREFIX_LANG: Record<string, string> = {
  a: "en",
  b: "en",
  j: "ja",
  z: "zh",
  e: "es",
  f: "fr",
  h: "hi",
  i: "it",
  p: "pt",
};

/**
 * True when `voice` looks like a kokoro-style voice id (see `KOKORO_VOICE_ID`)
 * whose self-encoded language does NOT match `lang`'s BCP-47 primary subtag —
 * e.g. a learner's *global* `config.tts?.voice` fallback is still "jf_alpha"
 * (Japanese) while the text being read is English. This exists to catch
 * exactly that stale-global-voice trap: kokoro voice ids hard-select a
 * language on the provider side regardless of any `lang` hint sent alongside
 * them, so forwarding a mismatched one over the wire defeats the AI Network
 * TTS lang-hint entirely (see hooks/useSpeech.ts's network engine).
 *
 * Deliberately never applied to a *per-language* override
 * (`resolveVoiceOverride`'s result) — the learner picked that voice
 * specifically for `lang`, so by construction it can't be "mismatched" in
 * this sense even if it happens to also look kokoro-shaped.
 *
 * false whenever `lang` is empty/unresolved (nothing to mismatch against) or
 * `voice` isn't kokoro-shaped at all — a multi-language voice (e.g. OpenAI's
 * "alloy") is never second-guessed this way, since it isn't locked to one
 * language the way a kokoro voice id is.
 */
export function isLangMismatchedKokoroVoice(voice: string | undefined, lang: string | undefined): boolean {
  if (!voice || !lang) return false;
  const match = KOKORO_VOICE_ID.exec(voice.trim());
  if (!match) return false;
  const prefixLang = KOKORO_PREFIX_LANG[match[1].toLowerCase()];
  if (!prefixLang) return false;
  return prefixLang !== primaryLangSubtag(lang);
}

/** Which of the two voice sources (or neither) a resolved network-TTS voice
 * came from — for `resolveNetworkVoice`'s result and the `[lingo tts]`
 * diagnostic log (hooks/useSpeech.ts). `"suppressed(none)"` covers both "the
 * global voice was kokoro-mismatched for `lang` and got dropped" and "there
 * was no global voice to begin with" — either way nothing is sent and the
 * request rides on the `lang` hint alone. */
export type NetworkVoiceSource = "perLang" | "global" | "suppressed(none)";

export interface NetworkVoiceResolution {
  voice: string | undefined;
  source: NetworkVoiceSource;
}

/**
 * Resolves the voice to send alongside a network TTS request's `lang` hint,
 * applying the wire contract's "explicit voice beats the lang hint" rule
 * without letting that rule undermine itself when the *global* fallback voice
 * turns out to be lang-locked (see `isLangMismatchedKokoroVoice`):
 *
 *   1. A per-language override for `lang` (`ttsVoiceByLanguage`) always wins
 *      outright — the learner picked it specifically for this language, so
 *      it's never second-guessed.
 *   2. Otherwise, `globalVoice` (the shared config's single `config.tts?.voice`)
 *      is sent as-is UNLESS it's a kokoro voice id mismatched against `lang`,
 *      in which case it's suppressed (omitted) so the request carries only
 *      the `lang` hint, letting the room's provider pick a same-language
 *      voice on its own instead of being locked into the wrong one.
 *
 * Used by hooks/useSpeech.ts's network engine (global-voice suppression) —
 * NOT by the "api"/"browser" engines, which keep sending the configured voice
 * unconditionally (see useSpeech.ts's module doc comment).
 */
export function resolveNetworkVoice(
  ttsVoiceByLanguage: Record<string, string> | undefined,
  globalVoice: string | undefined,
  lang: string | undefined,
): NetworkVoiceResolution {
  const perLang = resolveVoiceOverride(ttsVoiceByLanguage, lang);
  if (perLang) return { voice: perLang, source: "perLang" };
  if (isLangMismatchedKokoroVoice(globalVoice, lang)) return { voice: undefined, source: "suppressed(none)" };
  return { voice: globalVoice, source: "global" };
}
