import { base64ToUtf8, chunkBase64, randomId, utf8ToBase64 } from "@tik-choco/mistai";
import type { DelegationV1, DidIdentity } from "@tik-choco/mistai/identity";
import { deriveSessionKey, newChallenge, seal, signAuth, unseal, verifyAuth } from "./didProtocol";
import type { Auth, DidMessage, Discover, Hello } from "./didProtocol";
import { ChunkAssembler, MAX_SYNC_BASE64_CHARS } from "./protocol";
import type { SyncMessage } from "./protocol";
import { buildSyncSnapshot, mergeSyncSnapshot } from "./snapshot";

// Leave room for the JSON headers, GCM tag and outer base64 under mist's 16 KiB limit.
const CHUNK = 8 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_SYNC_BASE64_CHARS / CHUNK);
const REQUEST: SyncMessage = { v: 1, type: "lingo_sync_hello" };

interface PeerOptions {
  identity: DidIdentity;
  delegation: DelegationV1;
  send(message: DidMessage): void;
  changed(): void;
  synced(): void;
  failed(errorKey?: string): void;
}

/** One ordered, unicast data channel. No traffic from another transport peer
 * can complete this peer's challenge, confirm its key or add to its transfer. */
export function createDidPeer(options: PeerOptions) {
  const { identity, delegation } = options;
  let closed = false;
  let remote: Hello | undefined;
  let auth: Auth | undefined;
  let key: CryptoKey | undefined;
  let expires = Date.parse(delegation.exp);
  let confirmed = false;
  let sent = 0;
  let received = 0;
  let queued = 0;
  let sending = false;
  let dirty = false;
  let awaitingAck: string | null = null;
  let incoming: { id: string; chunks: ChunkAssembler } | null = null;
  let lastProgress = Date.now();
  const started = lastProgress;
  let nextRetry = started + 2_000;
  const challenge = newChallenge(identity.did);
  function live() { return !closed && Date.now() < expires; }
  function send(message: DidMessage) { if (live()) options.send(message); }
  function fail(errorKey?: string) {
    if (closed) return;
    closed = true;
    options.failed(errorKey);
  }
  let input = challenge.then(({ hello }) => send(hello)).catch(() => fail("settings-did-connect-error"));
  let output = Promise.resolve();

  // Sends from a merge acknowledgement, local edit and request can overlap.
  // Serializing encryption preserves the authenticated sequence on the wire.
  function sendEncrypted(message: SyncMessage) {
    output = output.then(async () => {
      if (!live() || !key) return;
      const { hello } = await challenge;
      send(await seal(key, hello.nonce, ++sent, message));
    }).catch(() => fail("settings-did-connect-error"));
    return output;
  }

  async function push() {
    if (!confirmed || !live()) return;
    if (sending) { dirty = true; return; }
    sending = true;
    options.changed();
    try {
      do {
        dirty = false;
        const data = utf8ToBase64(JSON.stringify(buildSyncSnapshot()));
        if (data.length > MAX_SYNC_BASE64_CHARS) { fail("settings-sync-error-data"); return; }
        const parts = chunkBase64(data, CHUNK);
        const id = randomId();
        awaitingAck = id;
        lastProgress = Date.now();
        for (let seq = 0; seq < parts.length && live(); seq++) {
          await sendEncrypted({ v: 1, type: "lingo_sync_data", id, seq, last: seq === parts.length - 1, data: parts[seq] });
          lastProgress = Date.now();
        }
      } while (dirty && live());
    } catch { fail("settings-sync-error-data"); }
    finally { sending = false; if (live()) options.changed(); }
  }

  async function handle(msg: Exclude<DidMessage, Discover>) {
    const { hello, privateKey } = await challenge;
    if (!live()) return;
    if (msg.type === "lingo_didsync_hello") {
      if (remote || msg.nonce === hello.nonce || msg.ephPub === hello.ephPub) return;
      remote = msg;
      send(hello); // Our first hello can predate the remote channel opening.
      auth = await signAuth(identity, delegation, hello, remote);
      send(auth);
      return;
    }
    if (!remote || !auth) return;
    if (msg.type === "lingo_didsync_auth") {
      if (key || msg.peerNonce !== hello.nonce) return;
      if (!await verifyAuth(msg, hello, remote, delegation.root)) { fail(); return; }
      expires = Math.min(expires, Date.parse(msg.delegation.exp));
      key = await deriveSessionKey(privateKey, hello, remote);
      // This encrypted request proves we verified the other side's auth.
      await sendEncrypted(REQUEST);
      return;
    }
    if (!key || msg.n <= received) return;
    const inner = await unseal(key, remote.nonce, msg);
    if (!live() || !inner) return;
    received = msg.n;
    lastProgress = Date.now();
    if (inner.type === "lingo_sync_hello") {
      confirmed = true;
      void push();
      return;
    }
    if (!confirmed) return;
    if (inner.type === "lingo_sync_done" && inner.id === awaitingAck) {
      awaitingAck = null;
      options.synced();
    }
    if (inner.type !== "lingo_sync_data") return;
    if (inner.seq >= MAX_CHUNKS || inner.id.length > 128 || inner.data.length > CHUNK) {
      fail("settings-sync-error-data"); return;
    }
    if (!incoming || incoming.id !== inner.id) {
      if (inner.seq !== 0) return;
      incoming = { id: inner.id, chunks: new ChunkAssembler() };
      options.changed();
    }
    if (incoming.chunks.add(inner.seq, inner.data, inner.last) === "too-large") {
      fail("settings-sync-error-data"); return;
    }
    if (!incoming.chunks.isComplete) return;
    const data = incoming.chunks.assemble();
    incoming = null;
    if (!data || !mergeSyncSnapshot(JSON.parse(base64ToUtf8(data)))) { fail("settings-sync-error-data"); return; }
    options.synced();
    await sendEncrypted({ v: 1, type: "lingo_sync_done", id: inner.id });
  }

  return {
    get ready() { return confirmed && live(); },
    get busy() { return !!(sending || incoming || awaitingAck); },
    get remoteNonce() { return remote?.nonce; },
    receive(msg: Exclude<DidMessage, Discover>) {
      if (!live() || (msg.type === "lingo_didsync_sealed" && !remote)) return;
      if (queued >= (key ? MAX_CHUNKS + 16 : 16)) { fail(); return; }
      queued++;
      input = input.then(() => handle(msg)).catch(() => fail(confirmed ? "settings-sync-error-data" : undefined))
        .finally(() => { queued--; });
    },
    push,
    request() { if (confirmed && live()) { void sendEncrypted(REQUEST); void push(); } },
    tick(now: number) {
      if (!live() || (!confirmed && now - started > 45_000)) { fail(); return; }
      if (confirmed) {
        if ((incoming || awaitingAck) && now - lastProgress > 120_000) fail("settings-did-connect-error");
      } else if (now >= nextRetry) {
        nextRetry = now + 2_000;
        void challenge.then(({ hello }) => {
          send(hello);
          if (auth) send(auth);
          if (key) void sendEncrypted(REQUEST);
        }).catch(() => fail("settings-did-connect-error"));
      }
    },
    close() { closed = true; incoming = null; },
  };
}
