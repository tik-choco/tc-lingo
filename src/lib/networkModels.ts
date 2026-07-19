// Helpers for representing LLM Network–discovered models in the shared llm
// config: they live under a pseudo-provider whose baseUrl uses the
// `mist-network://` scheme (one per Room ID), so other tik-choco apps see a
// syntactically valid provider entry while this app can recognize and
// special-case it (no HTTP model fetch, network transport routing).
//
// Ported from tc-translate's src/lib/networkModels.ts (see
// tc-docs/drafts/llm-settings-common-v1.md §2.2/§4.1/§4.2) — kept byte-for-byte
// identical since this file has no app-specific dependencies.
export const NETWORK_PROVIDER_LABEL = 'AI Network'
export const NETWORK_PROVIDER_URL_PREFIX = 'mist-network://'

export function networkProviderBaseUrl(roomId: string): string {
  return `${NETWORK_PROVIDER_URL_PREFIX}${roomId.trim() || 'default'}`
}

export function isNetworkProviderBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().startsWith(NETWORK_PROVIDER_URL_PREFIX)
}

/**
 * The name a shared preset is advertised under in `provider_hello.models`,
 * and the key incoming model-specific requests are matched back to a target
 * by: the preset's user-facing label, falling back to the raw model id when
 * the label is blank. Room-level convention (shared with tc-translate and
 * other tik-choco apps): the advertised strings are display names doubling as
 * opaque routing keys, NOT necessarily upstream model ids — consumers echo
 * them back verbatim and only the provider that advertised a name knows
 * which upstream preset it maps to. Wire-compatible with peers that
 * advertise plain model ids (label defaults to the model id).
 */
export function advertisedModelName(target: { label: string; model: string }): string {
  return target.label.trim() || target.model
}

/** Sentinel voice-config model meaning "let the room's provider use its own configured TTS model". Stored in the shared config's tts model field alongside a mist-network pseudo-provider id; stripped from outgoing requests (an omitted wire model → provider's own default). */
export const NETWORK_VOICE_AUTO_MODEL = 'network-auto'

/** Maps a configured voice model to the wire request param: the auto sentinel becomes undefined (omit), anything else passes through (empty → undefined too). */
export function networkVoiceModelParam(model: string): string | undefined {
  const trimmed = model.trim()
  return !trimmed || trimmed === NETWORK_VOICE_AUTO_MODEL ? undefined : trimmed
}
