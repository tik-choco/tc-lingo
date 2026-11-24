import { createDidIdentity, parseStoredDidIdentity } from "@tik-choco/mistai/identity";
import type { DidIdentity } from "@tik-choco/mistai/identity";
import { storageAddJson, storageGetText } from "../mistStorage";

export const SHARED_IDENTITY_CID = "tc-shared-did-identity-cid-v1";
const MIRROR = "tc-lingo-did-identity-v1";
let cached: Promise<DidIdentity> | undefined;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Use the in-memory identity. */ }
}

async function withStorageDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(reject, 5_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveIdentity(): Promise<DidIdentity> {
  const cid = read(SHARED_IDENTITY_CID);
  let identity: DidIdentity | undefined;
  let publishShared = !cid;
  if (cid) {
    try {
      identity = parseStoredDidIdentity(await withStorageDeadline(storageGetText(cid)));
      publishShared = !identity;
    }
    catch { /* Preserve an unreachable shared pointer for its owner. */ }
  }
  identity ??= parseStoredDidIdentity(read(MIRROR)) ?? await createDidIdentity();
  if (publishShared) {
    try {
      const next = await withStorageDeadline(storageAddJson("tc-shared", identity));
      if (read(SHARED_IDENTITY_CID) === cid) write(SHARED_IDENTITY_CID, next);
      else return resolveIdentity(); // Another app published first.
    } catch {
      if (read(SHARED_IDENTITY_CID) !== cid) return resolveIdentity();
      // OPFS can be unavailable even when localStorage works.
    }
  } else if (cid !== read(SHARED_IDENTITY_CID)) {
    return resolveIdentity();
  }
  write(MIRROR, JSON.stringify(identity));
  return identity;
}

export function invalidateDidIdentity(): void {
  cached = undefined;
}

export function ensureDidIdentity(): Promise<DidIdentity> {
  if (!cached) {
    const pending = resolveIdentity();
    cached = pending;
    void pending.catch(() => { if (cached === pending) cached = undefined; });
  }
  return cached;
}
