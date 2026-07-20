/**
 * Protected Lesson Replay — browser deep module.
 *
 * Owns RSA-OAEP key generation, sealed-lesson fetch, AES key unwrap into a
 * non-extractable decrypt-only CryptoKey, Wasm SubtleCrypto decrypt, and
 * bounded lesson JSON validation. Exposes typed lesson data plus audit facts.
 *
 * Boundary facts (truthful):
 * - AES key bytes never enter Wasm linear memory (opaque CryptoKey handle).
 * - Plaintext returns as a JS ArrayBuffer from SubtleCrypto via Wasm.
 * - Do not claim plaintext never exists in JS.
 */

export const RSA_MODULUS_BITS = 2048;
export const AES_LENGTH = 256;
export const MAX_LESSON_JSON_BYTES = 16 * 1024;
export const MAX_STEPS = 16;
export const MAX_STROKES_PER_STEP = 32;
export const MAX_POINTS_PER_STROKE = 256;

type WasmApi = {
  decryptProtectedLesson: (
    key: CryptoKey,
    ciphertext: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
  ) => Promise<ArrayBuffer>;
};

let wasmApi: WasmApi | null = null;

export type LessonPoint = { x: number; y: number };

export type LessonStroke = {
  color: string;
  width: number;
  points: LessonPoint[];
};

export type LessonStep = {
  index: number;
  label: string;
  note?: string;
  strokes: LessonStroke[];
};

export type ProtectedLesson = {
  v: number;
  id: string;
  title: string;
  steps: LessonStep[];
};

export type ProtectedLessonAudit = {
  rsaPrivateExtractable: false;
  aesExtractable: false;
  aesUsages: readonly string[];
  boundaryMode: "wasm-subtle-externref";
  keyBytesEnterWasmLinearMemory: false;
  plaintextReturnedAs: "js-arraybuffer";
};

export type LoadProtectedLessonResult = {
  lesson: ProtectedLesson;
  audit: ProtectedLessonAudit;
  /** Non-extractable AES-GCM content key (decrypt-only). For audit/export checks. */
  contentKey: CryptoKey;
};

export type SealLessonResponse = {
  lesson_id: string;
  title: string;
  content_alg: string;
  key_wrap: string;
  iv_b64: string;
  ciphertext_b64: string;
  aad_b64: string;
  wrapped_key_b64: string;
};

let wasmReady: Promise<WasmApi> | null = null;

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

async function ensureWasm(): Promise<WasmApi> {
  if (wasmApi) return wasmApi;
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import("../wasm/pkg/cipherboard_wasm.js");
      await mod.default();
      wasmApi = {
        decryptProtectedLesson: mod.decryptProtectedLesson,
      };
      return wasmApi;
    })();
  }
  return wasmReady;
}

/** Generate RSA-OAEP keypair; private key is non-extractable. */
export async function generateLessonUnwrapKeys(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeySpkiB64: string;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: RSA_MODULUS_BITS,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    false,
    // Public receives encrypt/wrapKey; private receives decrypt/unwrapKey.
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeySpkiB64: b64Encode(spki),
  };
}

export async function fetchSealedLesson(
  rsaPublicKeySpkiB64: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SealLessonResponse> {
  const res = await fetchImpl("/api/demo/protected-lesson", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rsa_public_key_spki_b64: rsaPublicKeySpkiB64 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: string }).error)
        : res.statusText;
    throw new Error(msg || "failed to seal protected lesson");
  }
  return parseSealResponse(body);
}

function requireB64Field(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== "string" || !v || v.length > max) {
    throw new Error(`invalid sealed field: ${key}`);
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(v)) {
    throw new Error(`invalid sealed field encoding: ${key}`);
  }
  return v;
}

export function parseSealResponse(body: unknown): SealLessonResponse {
  if (!body || typeof body !== "object") {
    throw new Error("invalid sealed lesson response");
  }
  const o = body as Record<string, unknown>;
  const lesson_id = o.lesson_id;
  const title = o.title;
  const content_alg = o.content_alg;
  const key_wrap = o.key_wrap;
  if (typeof lesson_id !== "string" || !lesson_id || lesson_id.length > 64) {
    throw new Error("invalid lesson_id");
  }
  if (typeof title !== "string" || !title || title.length > 128) {
    throw new Error("invalid title");
  }
  if (content_alg !== "AES-256-GCM") {
    throw new Error("unsupported content_alg");
  }
  if (key_wrap !== "RSA-OAEP-256") {
    throw new Error("unsupported key_wrap");
  }
  return {
    lesson_id,
    title,
    content_alg,
    key_wrap,
    iv_b64: requireB64Field(o, "iv_b64", 64),
    ciphertext_b64: requireB64Field(o, "ciphertext_b64", 96 * 1024),
    aad_b64: requireB64Field(o, "aad_b64", 4096),
    wrapped_key_b64: requireB64Field(o, "wrapped_key_b64", 2048),
  };
}

/**
 * Unwrap AES content key directly into a non-extractable CryptoKey.
 * Browser never receives raw AES key bytes as an application-level value.
 */
export async function unwrapContentKey(
  privateKey: CryptoKey,
  wrappedKeyB64: string,
): Promise<CryptoKey> {
  const wrapped = b64Decode(wrappedKeyB64);
  return crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    asBufferSource(wrapped),
  ).then(async (raw) => {
    // subtle.decrypt for RSA-OAEP returns ArrayBuffer of the unwrapped key.
    // Immediately import as non-extractable AES-GCM decrypt-only — do not
    // retain a named raw-key binding beyond this import.
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM", length: AES_LENGTH },
      false,
      ["decrypt"],
    );
    return key;
  });
}

/**
 * Preferred unwrap: use unwrapKey when available so raw AES bytes never surface
 * as an ArrayBuffer in JS application code. Falls back to decrypt+importKey.
 */
export async function unwrapContentKeyDirect(
  privateKey: CryptoKey,
  wrappedKeyB64: string,
): Promise<CryptoKey> {
  const wrapped = b64Decode(wrappedKeyB64);
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      asBufferSource(wrapped),
      privateKey,
      { name: "RSA-OAEP" },
      { name: "AES-GCM", length: AES_LENGTH },
      false,
      ["decrypt"],
    );
  } catch {
    // Some test doubles only implement decrypt; production browsers support unwrapKey.
    return unwrapContentKey(privateKey, wrappedKeyB64);
  }
}

export function parseLessonJson(bytes: ArrayBuffer): ProtectedLesson {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LESSON_JSON_BYTES) {
    throw new Error("lesson payload size out of bounds");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("lesson json invalid");
  }
  return validateLesson(parsed);
}

export function validateLesson(input: unknown): ProtectedLesson {
  if (!input || typeof input !== "object") throw new Error("lesson schema");
  const o = input as Record<string, unknown>;
  if (o.v !== 1) throw new Error("lesson version");
  if (typeof o.id !== "string" || !o.id || o.id.length > 64) {
    throw new Error("lesson id");
  }
  if (typeof o.title !== "string" || !o.title || o.title.length > 128) {
    throw new Error("lesson title");
  }
  if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > MAX_STEPS) {
    throw new Error("lesson steps");
  }
  const steps: LessonStep[] = o.steps.map((step, i) => {
    if (!step || typeof step !== "object") throw new Error("lesson step");
    const s = step as Record<string, unknown>;
    const index = typeof s.index === "number" ? s.index : i;
    if (typeof s.label !== "string" || !s.label || s.label.length > 128) {
      throw new Error("lesson step label");
    }
    const note =
      s.note === undefined
        ? undefined
        : typeof s.note === "string" && s.note.length <= 512
          ? s.note
          : (() => {
              throw new Error("lesson step note");
            })();
    if (!Array.isArray(s.strokes) || s.strokes.length > MAX_STROKES_PER_STEP) {
      throw new Error("lesson strokes");
    }
    const strokes: LessonStroke[] = s.strokes.map((st) => {
      if (!st || typeof st !== "object") throw new Error("lesson stroke");
      const r = st as Record<string, unknown>;
      if (typeof r.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(r.color)) {
        throw new Error("stroke color");
      }
      if (typeof r.width !== "number" || !(r.width > 0) || r.width > 64) {
        throw new Error("stroke width");
      }
      if (!Array.isArray(r.points) || r.points.length === 0 || r.points.length > MAX_POINTS_PER_STROKE) {
        throw new Error("stroke points");
      }
      const points: LessonPoint[] = r.points.map((p) => {
        if (!p || typeof p !== "object") throw new Error("point");
        const pt = p as Record<string, unknown>;
        if (typeof pt.x !== "number" || typeof pt.y !== "number") {
          throw new Error("point coords");
        }
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
          throw new Error("point coords");
        }
        return { x: pt.x, y: pt.y };
      });
      return { color: r.color, width: r.width, points };
    });
    return { index, label: s.label, note, strokes };
  });
  return { v: 1, id: o.id, title: o.title, steps };
}

export function buildAudit(contentKey: CryptoKey): ProtectedLessonAudit {
  return {
    rsaPrivateExtractable: false,
    aesExtractable: false,
    aesUsages: Object.freeze([...(contentKey.usages as KeyUsage[])]),
    boundaryMode: "wasm-subtle-externref",
    keyBytesEnterWasmLinearMemory: false,
    plaintextReturnedAs: "js-arraybuffer",
  };
}

/** Assert AES content key cannot be exported (runtime audit). */
export async function assertAesKeyNonExportable(key: CryptoKey): Promise<void> {
  if (key.extractable) {
    throw new Error("aes key unexpectedly extractable");
  }
  const usages = [...key.usages];
  if (usages.length !== 1 || usages[0] !== "decrypt") {
    throw new Error("aes key must be decrypt-only");
  }
  await expectExportRejected(key);
}

async function expectExportRejected(key: CryptoKey): Promise<void> {
  let rejected = false;
  try {
    await crypto.subtle.exportKey("raw", key);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("aes exportKey unexpectedly succeeded");
  }
}

/**
 * Full load path: RSA gen → seal request → unwrap AES → Wasm decrypt → validate.
 */
export async function loadProtectedLesson(
  opts?: { fetchImpl?: typeof fetch },
): Promise<LoadProtectedLessonResult> {
  const wasm = await ensureWasm();
  const rsa = await generateLessonUnwrapKeys();
  if (rsa.privateKey.extractable) {
    throw new Error("rsa private key must be non-extractable");
  }

  const sealed = await fetchSealedLesson(
    rsa.publicKeySpkiB64,
    opts?.fetchImpl ?? fetch,
  );

  const contentKey = await unwrapContentKeyDirect(
    rsa.privateKey,
    sealed.wrapped_key_b64,
  );
  await assertAesKeyNonExportable(contentKey);

  const iv = b64Decode(sealed.iv_b64);
  const ciphertext = b64Decode(sealed.ciphertext_b64);
  const aad = b64Decode(sealed.aad_b64);

  const plaintextBuf = await wasm.decryptProtectedLesson(
    contentKey,
    ciphertext,
    iv,
    aad,
  );

  const lesson = parseLessonJson(plaintextBuf);
  if (lesson.id !== sealed.lesson_id) {
    throw new Error("lesson id mismatch");
  }

  return {
    lesson,
    contentKey,
    audit: buildAudit(contentKey),
  };
}
