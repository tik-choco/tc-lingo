import { base64ToBytes, bytesToBase64 } from "@tik-choco/mistai";
import {
  isEd25519DidKey, parseDelegation, signStringWithDidIdentity, stableStringify, verifyDelegation, verifyStringWithDid,
} from "@tik-choco/mistai/identity";
import type { DelegationV1, DidIdentity } from "@tik-choco/mistai/identity";
import { decodeSync, DID_ROOM_PREFIX, encodeSync } from "./protocol";
import type { SyncMessage } from "./protocol";

const DOMAIN = "tc-lingo/did-sync/v1";
const utf8 = new TextEncoder();
const decoder = new TextDecoder();
const MAX_FRAME = 16 * 1024;

export interface Hello {
  v: 1;
  type: "lingo_didsync_hello";
  leaf: string;
  nonce: string;
  ephPub: string;
}
export interface Auth {
  v: 1;
  type: "lingo_didsync_auth";
  leaf: string;
  delegation: DelegationV1;
  peerNonce: string;
  ephPub: string;
  ownNonce: string;
  sig: string;
}
export interface Sealed {
  v: 1;
  type: "lingo_didsync_sealed";
  n: number;
  iv: string;
  data: string;
}
export interface Discover {
  v: 1;
  type: "lingo_didsync_discover";
  reply: boolean;
}
export type DidMessage = Discover | Hello | Auth | Sealed;

function url64(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unurl(value: string) {
  return base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/"));
}
function fixedUrl(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[A-Za-z0-9_-]+$/.test(value);
}

export function decodeDidMessage(payload: unknown): DidMessage | null {
  if (payload instanceof ArrayBuffer) payload = new Uint8Array(payload);
  else if (ArrayBuffer.isView(payload)) payload = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  else if (Array.isArray(payload) && payload.length <= MAX_FRAME) payload = Uint8Array.from(payload);
  if (typeof payload !== "string" && !(payload instanceof Uint8Array)) return null;
  if (payload.length > MAX_FRAME) return null;
  try {
    const m = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
    if (m?.v !== 1) return null;
    if (m.type === "lingo_didsync_discover") return typeof m.reply === "boolean" ? { v: 1, type: m.type, reply: m.reply } : null;
    if (m.type === "lingo_didsync_sealed") {
      return Number.isSafeInteger(m.n) && m.n > 0 && fixedUrl(m.iv, 16) && typeof m.data === "string" ? m : null;
    }
    if (typeof m.leaf !== "string" || m.leaf.length > 96 || !isEd25519DidKey(m.leaf) || !fixedUrl(m.ephPub, 87)) return null;
    if (m.type === "lingo_didsync_hello" && fixedUrl(m.nonce, 22)) {
      return { v: 1, type: m.type, leaf: m.leaf, nonce: m.nonce, ephPub: m.ephPub };
    }
    if (m.type === "lingo_didsync_auth" && fixedUrl(m.peerNonce, 22) && fixedUrl(m.ownNonce, 22) && fixedUrl(m.sig, 86)) {
      const delegation = parseDelegation(JSON.stringify(m.delegation));
      if (delegation) return { v: 1, type: m.type, leaf: m.leaf, ephPub: m.ephPub,
        ownNonce: m.ownNonce, peerNonce: m.peerNonce, sig: m.sig, delegation };
    }
  } catch { /* Foreign or malformed traffic. */ }
  return null;
}

export async function didRoomId(rootDid: string) {
  const hash = await crypto.subtle.digest("SHA-256", utf8.encode(DOMAIN + "|" + rootDid));
  return DID_ROOM_PREFIX + Array.from(new Uint8Array(hash, 0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function newChallenge(leaf: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephPub = url64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const nonce = url64(crypto.getRandomValues(new Uint8Array(16)));
  const hello: Hello = { v: 1, type: "lingo_didsync_hello", leaf, nonce, ephPub };
  return { hello, privateKey: pair.privateKey };
}

function transcript(sender: Hello, recipient: Hello, delegation: DelegationV1) {
  const fields = ({ leaf, nonce, ephPub }: Hello) => ({ leaf, nonce, ephPub });
  return stableStringify({ domain: "tc-lingo/did-sync/auth/v1", sender: fields(sender), recipient: fields(recipient), delegation });
}

export async function signAuth(identity: DidIdentity, delegation: DelegationV1, own: Hello, peer: Hello): Promise<Auth> {
  const sig = await signStringWithDidIdentity(identity, transcript(own, peer, delegation));
  return { v: 1, type: "lingo_didsync_auth", leaf: own.leaf, delegation, peerNonce: peer.nonce,
    ephPub: own.ephPub, ownNonce: own.nonce, sig };
}

export async function verifyAuth(auth: Auth, own: Hello, peer: Hello, root: string): Promise<boolean> {
  if (own.nonce === peer.nonce || own.ephPub === peer.ephPub || auth.peerNonce !== own.nonce ||
      auth.ownNonce !== peer.nonce || auth.leaf !== peer.leaf || auth.ephPub !== peer.ephPub ||
      auth.delegation.root !== root || Date.parse(auth.delegation.exp) <= Date.now()) return false;
  try {
    return await verifyDelegation(auth.delegation, { leaf: peer.leaf }) &&
      await verifyStringWithDid(peer.leaf, transcript(peer, own, auth.delegation), auth.sig);
  } catch { return false; }
}

export async function deriveSessionKey(privateKey: CryptoKey, own: Hello, peer: Hello) {
  const pub = await crypto.subtle.importKey("raw", unurl(peer.ephPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(32);
  [own.nonce, peer.nonce].sort().forEach((nonce, i) => salt.set(unurl(nonce), i * 16));
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8.encode(DOMAIN) },
    hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Direction and counter are authenticated to reject reflections and replays
// even when the same leaf is installed on both devices.
function aad(senderNonce: string, n: number) {
  return utf8.encode([DOMAIN, senderNonce, n].join("|"));
}

export async function seal(key: CryptoKey, senderNonce: string, n: number, message: SyncMessage): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(senderNonce, n) },
    key, new Uint8Array(encodeSync(message)));
  return { v: 1, type: "lingo_didsync_sealed", n, iv: url64(iv), data: bytesToBase64(new Uint8Array(data)) };
}

export async function unseal(key: CryptoKey, senderNonce: string, msg: Sealed) {
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unurl(msg.iv), additionalData: aad(senderNonce, msg.n) },
    key, base64ToBytes(msg.data));
  return decodeSync(new Uint8Array(bytes));
}
