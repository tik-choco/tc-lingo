// OpenAI-compatible text embeddings (POST {baseUrl}/embeddings), used only by
// lib/cardAutoOrganize.ts's similar-card pre-filter. Modeled on lib/tts.ts's
// synthesizeSpeechApi: a raw fetch against the configured direct-API preset,
// not routed through @tik-choco/mistai (which is chat/TTS-only) — embeddings
// have no equivalent over the AI Network room transport, so this is only
// ever called with an "api"-kind LlmConnection's target.
export interface EmbeddingTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface EmbeddingResponseItem {
  index: number;
  embedding: number[];
}

/** POSTs `texts` to {baseUrl}/embeddings and resolves with one vector per
 * input, in the same order as `texts` (re-sorted by the response's `index`,
 * since providers aren't required to preserve order). Throws an Error
 * (message includes the HTTP status and up to 300 chars of the response
 * body) on a non-OK response, network failure, or malformed response shape. */
export async function requestEmbeddings(target: EmbeddingTarget, texts: string[]): Promise<number[][]> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/embeddings`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(target.apiKey.trim() ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: target.model, input: texts }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // best-effort only
    }
    throw new Error(`Embeddings request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }

  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Embeddings response missing \"data\" array");

  const items = body.data as unknown[];
  const sorted = items
    .filter((item): item is EmbeddingResponseItem => {
      const r = item as Record<string, unknown>;
      return typeof r === "object" && r !== null && typeof r.index === "number" && Array.isArray(r.embedding);
    })
    .sort((a, b) => a.index - b.index);

  if (sorted.length !== texts.length) throw new Error("Embeddings response item count didn't match the request");
  return sorted.map((item) => item.embedding);
}
