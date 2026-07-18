// Thin storage-only path into the vendored mistlib wasm module, used to pull
// down CID-addressed payloads published by other apps (e.g. tc-translate's
// `lingo-card-inbox` topic — see lib/cardInbox.ts). Deliberately independent
// of `network.ts`'s `ConsumerClient` (AI Network / LLM chat) usage —
// storage_add/storage_get only need the wasm node initialized, not a joined
// room — but reuses the same persisted node id so both features share one
// node identity. Ported byte-for-byte in shape from tc-translate's
// src/lib/mistStorage.ts (the two apps' vendored mistlib copies differ only
// in commit, not storage API surface).
//
// mistlib's storage_add/storage_get require `init_with_config` to have run
// first (see src/vendor/mistlib/wrappers/web/index.js's MistNode.init() for
// the equivalent LLM-Network-side init, used by network.ts). This lazily
// performs that init once, shared by every caller in this module.
//
// storageGetJson is currently the only entry point this app calls (payload
// resolution in cardInbox.ts); storageAdd/AddJson/AddText/Get/GetText are
// carried over unused for the planned `lingo-backup` topic (see CLAUDE.md's
// backlog), so a future backup publisher doesn't need to re-derive this
// module from scratch.

import init, * as mistWasm from '../vendor/mistlib/pkg/mistlib_wasm.js'
import { NODE_ID_STORAGE_KEY } from './network'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

let initPromise: Promise<void> | null = null

function loadOrCreateNodeId(): string {
  try {
    const stored = localStorage.getItem(NODE_ID_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // localStorage unavailable; fall through to an in-memory id.
  }
  const nodeId = `node-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
  try {
    localStorage.setItem(NODE_ID_STORAGE_KEY, nodeId)
  } catch {
    // Best-effort persistence; an in-memory id still works for this session.
  }
  return nodeId
}

async function ensureStorageNodeInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await init()
      mistWasm.init_with_config(
        loadOrCreateNodeId(),
        JSON.stringify({ signaling: { mode: 'nostr', nostr: { relays: [] } } }),
      )
    })().catch((err) => {
      initPromise = null
      throw err
    })
  }
  return initPromise
}

/** Stores raw bytes under `name` and returns the resulting content-address (CID). */
export async function storageAdd(name: string, data: Uint8Array): Promise<string> {
  await ensureStorageNodeInit()
  return mistWasm.storage_add(name, data)
}

/** Fetches previously-stored bytes for `cid`. Throws if the data isn't available. */
export async function storageGet(cid: string): Promise<Uint8Array> {
  await ensureStorageNodeInit()
  return mistWasm.storage_get(cid)
}

/** Stores `value` as JSON and returns the resulting CID. */
export async function storageAddJson(name: string, value: unknown): Promise<string> {
  return storageAdd(name, textEncoder.encode(JSON.stringify(value)))
}

/** Fetches and JSON-parses the bytes stored at `cid`. */
export async function storageGetJson<T>(cid: string): Promise<T> {
  const bytes = await storageGet(cid)
  return JSON.parse(textDecoder.decode(bytes)) as T
}

/** Stores `text` as UTF-8 bytes and returns the resulting CID. */
export async function storageAddText(name: string, text: string): Promise<string> {
  return storageAdd(name, textEncoder.encode(text))
}

/** Fetches and UTF-8-decodes the bytes stored at `cid`. */
export async function storageGetText(cid: string): Promise<string> {
  const bytes = await storageGet(cid)
  return textDecoder.decode(bytes)
}
