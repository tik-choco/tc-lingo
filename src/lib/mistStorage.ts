import * as mistWasm from '@tik-choco/mistlib'
import { createAppNode } from './network'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

let initPromise: Promise<void> | null = null

async function ensureStorageNodeInit(): Promise<void> {
  if (!initPromise) {
    const node = createAppNode()
    initPromise = node.init().then(() => {
      node.leaveRoom()
    }).catch((err) => {
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
