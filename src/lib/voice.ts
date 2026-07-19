// Derives which transport "read this aloud" (hooks/useSpeech.ts) should use
// from the shared llm config instead of an app-local setting. Ported from
// tc-translate's src/lib/voice.ts (see
// tc-docs/drafts/llm-settings-common-v1.md §4.1) — only the
// `deriveVoiceEngine` function is brought over (tc-translate's file also has
// STT/TTS HTTP request helpers this app doesn't need: TTS goes through
// lib/tts.ts's synthesizeSpeechApi, and this app has no STT at all). The
// signature stays generic ('tts' | 'stt') to match the reference
// implementation, even though tc-lingo only ever calls it with 'tts'.
import { resolvePreset, type SharedLlmConfigV1 } from './llmConfig'
import { isNetworkProviderBaseUrl } from './networkModels'
import type { TtsEngine } from '../types'

/**
 * Derives the TTS/STT engine ('browser' | 'api' | 'network') from the shared
 * llm config instead of an app-local setting:
 * - `config.tts`/`config.stt` absent, or its `model` blank -> 'browser'.
 * - Otherwise resolve the provider the same way resolveVoice does: the
 *   explicit `providerId` if set, else the default preset's provider (an
 *   explicit `providerId` that's dangling does NOT fall back to the default
 *   preset - that's the "unresolved" case below). If that provider's
 *   `baseUrl` starts with `mist-network://` (see isNetworkProviderBaseUrl in
 *   networkModels.ts) -> 'network'; any other baseUrl -> 'api'.
 * - A model IS set but the provider can't be resolved (dangling providerId,
 *   or no default preset) -> 'api', so the settings UI can still show its
 *   "connection unresolved" warning (the actual TTS/STT call falls back to
 *   the browser engine at runtime when the connection resolves empty).
 */
export function deriveVoiceEngine(config: SharedLlmConfigV1, kind: 'tts' | 'stt'): TtsEngine {
  const cfg = config[kind]
  if (!cfg || !cfg.model) return 'browser'

  const provider = cfg.providerId
    ? config.providers.find((p) => p.id === cfg.providerId)
    : (() => {
        const defaultTarget = resolvePreset(config)
        return defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined
      })()
  if (!provider) return 'api'

  return isNetworkProviderBaseUrl(provider.baseUrl) ? 'network' : 'api'
}
