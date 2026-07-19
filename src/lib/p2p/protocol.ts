// Wire protocol extension (v: 1) for tunneling an OpenAI-compatible HTTP
// request/response pair over an @tik-choco/mistai mist room, on top of the
// library's own protocol (llm_request / tts_request / ...).
//
// This is a tik-choco app-level protocol extension — a candidate for
// upstreaming into @tik-choco/mistai's protocol.ts once the shape has proven
// itself (see tc-docs/drafts/llm-settings-common-v1.md §4.6/§6). It is
// backward compatible: the library's own decode() only recognizes its own
// MESSAGE_TYPES set and silently returns null for "oai_request" /
// "oai_response" / "oai_error", so old peers running the unmodified library
// simply drop these messages instead of crashing.
//
// Bodies (request/response payloads, which may be arbitrary JSON or binary)
// are carried as base64 chunks so anything survives the JSON wire envelope;
// request/response metadata (path, method, status, contentType) rides on the
// seq 0 chunk only, mirroring stt_request's `model`/`fileName` convention in
// the library's protocol.ts.
//
// Ported byte-for-byte from tc-translate's src/lib/p2p/protocol.ts.
import { decode as decodeLib, type ProtocolMessage } from '@tik-choco/mistai'

/** provider_hello.services marker: this peer will tunnel OpenAI-compatible HTTP requests. */
export const OAI_TUNNEL_SERVICE = 'oai'

export interface OaiRequestMsg {
  v: 1
  type: 'oai_request'
  id: string
  seq: number
  last: boolean
  /** Base64 chunk of the UTF-8 request body; may be '' for an empty/no body. */
  data: string
  // The following ride on seq 0 only.
  path?: string
  method?: string
  contentType?: string
}

export interface OaiResponseMsg {
  v: 1
  type: 'oai_response'
  id: string
  seq: number
  last: boolean
  /** Base64 chunk of the UTF-8 response body; may be '' for an empty body. */
  data: string
  // The following ride on seq 0 only.
  status?: number
  contentType?: string
}

/** Correlates to the request `id`; sent instead of any oai_response chunks. */
export interface OaiErrorMsg {
  v: 1
  type: 'oai_error'
  id: string
  message: string
  /** Optional machine-readable reason, e.g. "unsupported_path". */
  code?: string
}

export type OaiMessage = OaiRequestMsg | OaiResponseMsg | OaiErrorMsg

/** Union of the library's own wire messages plus this app's oai_* extension. */
export type ExtendedMessage = ProtocolMessage | OaiMessage

const OAI_MESSAGE_TYPES = new Set(['oai_request', 'oai_response', 'oai_error'])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isValidSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/**
 * Decodes and validates an oai_* message. Returns null for anything that
 * doesn't match the expected shape — peers are untrusted, same defensive
 * posture as the library's own decode().
 */
function decodeOai(m: Record<string, unknown>): OaiMessage | null {
  switch (m.type) {
    case 'oai_request': {
      if (!isNonEmptyString(m.id)) return null
      if (!isValidSeq(m.seq)) return null
      if (typeof m.data !== 'string') return null
      if (typeof m.last !== 'boolean') return null
      if (m.path !== undefined && typeof m.path !== 'string') return null
      if (m.method !== undefined && typeof m.method !== 'string') return null
      if (m.contentType !== undefined && typeof m.contentType !== 'string') return null
      const req: OaiRequestMsg = { v: 1, type: 'oai_request', id: m.id, seq: m.seq, last: m.last, data: m.data }
      return {
        ...req,
        ...(m.path !== undefined ? { path: m.path as string } : {}),
        ...(m.method !== undefined ? { method: m.method as string } : {}),
        ...(m.contentType !== undefined ? { contentType: m.contentType as string } : {}),
      }
    }
    case 'oai_response': {
      if (!isNonEmptyString(m.id)) return null
      if (!isValidSeq(m.seq)) return null
      if (typeof m.data !== 'string') return null
      if (typeof m.last !== 'boolean') return null
      if (m.status !== undefined && typeof m.status !== 'number') return null
      if (m.contentType !== undefined && typeof m.contentType !== 'string') return null
      const res: OaiResponseMsg = { v: 1, type: 'oai_response', id: m.id, seq: m.seq, last: m.last, data: m.data }
      return {
        ...res,
        ...(m.status !== undefined ? { status: m.status as number } : {}),
        ...(m.contentType !== undefined ? { contentType: m.contentType as string } : {}),
      }
    }
    case 'oai_error': {
      if (!isNonEmptyString(m.id)) return null
      if (typeof m.message !== 'string') return null
      const err: OaiErrorMsg = { v: 1, type: 'oai_error', id: m.id, message: m.message }
      return typeof m.code === 'string' ? { ...err, code: m.code } : err
    }
    default:
      return null
  }
}

/** Encodes an extended message to a JSON UTF-8 byte payload for sendMessage(). */
export function encodeExtended(msg: ExtendedMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg))
}

/**
 * Decodes and validates bytes/text received from a peer, understanding both
 * the library's own protocol messages and this app's oai_* extension.
 * Returns null for anything that doesn't match a known, valid shape.
 */
export function decodeExtended(data: Uint8Array | string): ExtendedMessage | null {
  const libMsg = decodeLib(data)
  if (libMsg) return libMsg

  // The library's decode() returns null both for "unrecognized type" (our
  // case) and for "malformed JSON"/"wrong v"/etc. Re-parse here rather than
  // threading a richer result back from decodeLib, since re-parsing a small
  // JSON string is cheap and keeps this file decoupled from the library's
  // internals.
  let text: string
  if (typeof data === 'string') {
    text = data
  } else {
    try {
      text = new TextDecoder().decode(data)
    } catch {
      return null
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const m = parsed as Record<string, unknown>
  if (m.v !== 1) return null
  if (typeof m.type !== 'string' || !OAI_MESSAGE_TYPES.has(m.type)) return null
  return decodeOai(m)
}
