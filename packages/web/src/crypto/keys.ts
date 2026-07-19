/**
 * WebCrypto key management for Cipherboard.
 *
 * Private keys and derived symmetric keys are non-extractable CryptoKey objects.
 * They never enter Wasm linear memory. Persistence uses IndexedDB structured clone.
 */

export const PROTOCOL_VERSION = 1;
export const ECDH_CURVE = "P-256" as const;
export const AES_LENGTH = 256;

export type IdentityKeys = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeySpkiB64: string;
  fingerprint: string;
};

function b64Encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

export function bytesToB64(bytes: Uint8Array): string {
  return b64Encode(bytes);
}

export function b64ToBytes(b64: string): Uint8Array {
  return b64Decode(b64);
}

/** Safety code / fingerprint from SPKI public key bytes (SHA-256, hex groups). */
export async function fingerprintFromSpki(spki: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", spki);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Group for human comparison: abcd efgh ...
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}

export async function generateIdentity(): Promise<IdentityKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: ECDH_CURVE },
    false, // non-extractable private key
    ["deriveBits"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const publicKeySpkiB64 = b64Encode(spki);
  const fingerprint = await fingerprintFromSpki(spki);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeySpkiB64,
    fingerprint,
  };
}

export async function importPeerPublicKey(spkiB64: string): Promise<CryptoKey> {
  const spki = b64Decode(spkiB64);
  return crypto.subtle.importKey(
    "spki",
    asBufferSource(spki),
    { name: "ECDH", namedCurve: ECDH_CURVE },
    true,
    [],
  );
}

/**
 * Derive a non-extractable AES-256-GCM key via ECDH + HKDF-SHA-256.
 * info binds room and both participant ids (sorted for direction independence of base secret,
 * then direction-specific salt for message keys sender->recipient).
 */
export async function deriveMessageKey(params: {
  privateKey: CryptoKey;
  peerPublicKey: CryptoKey;
  roomId: string;
  senderId: string;
  recipientId: string;
  epoch: number;
}): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: params.peerPublicKey },
    params.privateKey,
    256,
  );

  const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);

  const info = new TextEncoder().encode(
    `cipherboard/v${PROTOCOL_VERSION}/msg/${params.roomId}/${params.senderId}/${params.recipientId}/epoch/${params.epoch}`,
  );
  const salt = new TextEncoder().encode("cipherboard-hkdf-salt-v1");

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    ikm,
    { name: "AES-GCM", length: AES_LENGTH },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

export type AadContext = {
  protocolVersion: number;
  roomId: string;
  senderId: string;
  recipientId: string;
  eventId: string;
  branchId: string;
  seq?: number;
};

export function encodeAad(ctx: AadContext): { bytes: Uint8Array; json: string } {
  const obj = {
    v: ctx.protocolVersion,
    room: ctx.roomId,
    from: ctx.senderId,
    to: ctx.recipientId,
    event: ctx.eventId,
    branch: ctx.branchId,
    ...(ctx.seq !== undefined ? { seq: ctx.seq } : {}),
  };
  const json = JSON.stringify(obj);
  return { bytes: new TextEncoder().encode(json), json };
}

export async function encryptForRecipient(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: AadContext,
): Promise<{ ivB64: string; ciphertextB64: string; aadJson: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit
  const { bytes: aadBytes, json: aadJson } = encodeAad(aad);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asBufferSource(iv),
      additionalData: asBufferSource(aadBytes),
    },
    key,
    asBufferSource(plaintext),
  );
  return {
    ivB64: b64Encode(iv),
    ciphertextB64: b64Encode(ct),
    aadJson,
  };
}

export async function decryptFromSender(
  key: CryptoKey,
  ivB64: string,
  ciphertextB64: string,
  aadJson: string,
): Promise<Uint8Array> {
  const iv = b64Decode(ivB64);
  if (iv.length !== 12) throw new Error("invalid iv length");
  const ct = b64Decode(ciphertextB64);
  const aadBytes = new TextEncoder().encode(aadJson);
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asBufferSource(iv),
      additionalData: asBufferSource(aadBytes),
    },
    key,
    asBufferSource(ct),
  );
  return new Uint8Array(pt);
}

export async function randomId(prefix: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${b64Encode(bytes).replace(/[+/=]/g, "").slice(0, 16)}`;
}
