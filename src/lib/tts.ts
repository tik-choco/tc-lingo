// OpenAI-compatible TTS (POST {baseUrl}/audio/speech), the "api" engine half
// of hooks/useSpeech.ts's engine dispatch — the "network" half goes through
// lib/network.ts's requestNetworkTts instead, and "browser" is plain
// speechSynthesis with no HTTP call at all. `TtsVoiceTarget` is the shape
// resolveVoice(config, "tts") (lib/llmConfig.ts) resolves to once the shared
// config's `tts` entry is merged with its provider's connection info.
// Modeled on tc-news's lib/openaiTts.ts synthesizeSpeech and tc-translate's
// lib/voice.ts synthesizeSpeech.

export interface TtsVoiceTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
  speed?: number;
}

/** POSTs `text` to {baseUrl}/audio/speech and resolves with the returned
 * audio Blob (mp3). Throws an Error (message includes the HTTP status and up
 * to 300 chars of the response body) on a non-OK response or network
 * failure. */
export async function synthesizeSpeechApi(text: string, target: TtsVoiceTarget): Promise<Blob> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/audio/speech`;
  const body: Record<string, unknown> = {
    model: target.model,
    voice: target.voice || "alloy",
    input: text,
    response_format: "mp3",
  };
  if (target.speed !== undefined) body.speed = target.speed;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(target.apiKey.trim() ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // best-effort only
    }
    throw new Error(`TTS request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }

  return response.blob();
}
