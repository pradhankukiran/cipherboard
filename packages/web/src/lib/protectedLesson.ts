/**
 * Protected Lesson Replay — browser deep module.
 *
 * Owns RSA-OAEP key generation, sealed-lesson fetch, AES key unwrap into a
 * non-extractable decrypt-only CryptoKey via unwrapKey only, Wasm SubtleCrypto
 * decrypt, and bounded lesson JSON validation. Exposes typed lesson data plus
 * audit facts. Does not retain or return CryptoKey handles after load.
 *
 * Boundary facts (truthful):
 * - AES key bytes never enter Wasm linear memory (opaque CryptoKey handle).
 * - Plaintext returns as a JS ArrayBuffer from SubtleCrypto via Wasm.
 * - Do not claim plaintext never exists in JS.
 * - No application path surfaces unwrapped AES bytes as ArrayBuffer.
 */

export const RSA_MODULUS_BITS = 2048;
export const AES_LENGTH = 256;
export const IV_LEN = 12;
/** RSA-OAEP wrap of AES-256 under RSA-2048. */
export const WRAPPED_KEY_LEN = 256;
export const MAX_CIPHERTEXT_BYTES = 96 * 1024;
export const MAX_AAD_BYTES = 2048;
export const MAX_LESSON_JSON_BYTES = 16 * 1024;
export const MAX_SEAL_RESPONSE_BYTES = 48 * 1024;
export const MAX_STEPS = 16;
export const MAX_STROKES_PER_STEP = 32;
export const MAX_POINTS_PER_STROKE = 256;
export const AAD_PURPOSE = "protected-lesson";

type WasmApi = {
  decryptProtectedLesson: (
    key: CryptoKey,
    ciphertext: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
  ) => Promise<ArrayBuffer>;
};

let wasmApi: WasmApi | null = null;
let wasmReady: Promise<WasmApi> | null = null;

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
  rsaPrivateUsages: readonly string[];
  aesExtractable: false;
  aesUsages: readonly string[];
  /** Result of exportKey("raw") on the actual unwrapped content key. */
  aesExportAttempt: "rejected";
  boundaryMode: "wasm-subtle-externref";
  keyBytesEnterWasmLinearMemory: false;
  plaintextReturnedAs: "js-arraybuffer";
};

export type LoadProtectedLessonResult = {
  lesson: ProtectedLesson;
  audit: ProtectedLessonAudit;
};

export type SealLessonResponse = {
  lesson_id: string;
  demo: string;
  content_alg: string;
  key_wrap: string;
  iv_b64: string;
  ciphertext_b64: string;
  aad_b64: string;
  wrapped_key_b64: string;
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

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
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

/**
 * Canonical AAD contract mirrored by the server seal path.
 * `{"v":1,"purpose":"protected-lesson","lesson_id":"<id>"}`
 */
export function canonicalAadBytes(lessonId: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(lessonId)) {
    throw new Error("invalid lesson_id for aad");
  }
  return new TextEncoder().encode(
    `{"v":1,"purpose":"${AAD_PURPOSE}","lesson_id":"${lessonId}"}`,
  );
}

/** Generate RSA-OAEP keypair; private is non-extractable unwrapKey-only. */
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
    // Private receives unwrapKey only; public is exportable SPKI for the server.
    ["unwrapKey"],
  );
  if (pair.privateKey.extractable) {
    throw new Error("rsa private key must be non-extractable");
  }
  const privUsages = [...pair.privateKey.usages].sort();
  if (privUsages.length !== 1 || privUsages[0] !== "unwrapKey") {
    throw new Error("rsa private usages must be unwrapKey only");
  }
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeySpkiB64: b64Encode(spki),
  };
}

async function readBoundedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const cl = res.headers.get("content-length");
  if (cl !== null) {
    const n = Number(cl);
    if (!Number.isFinite(n) || n < 0 || n > maxBytes) {
      throw new Error("response too large");
    }
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    // UTF-16 length upper-bounds byte length for ASCII-heavy JSON.
    if (text.length > maxBytes) {
      throw new Error("response too large");
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchSealedLesson(
  rsaPublicKeySpkiB64: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<SealLessonResponse> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl("/api/demo/protected-lesson", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rsa_public_key_spki_b64: rsaPublicKeySpkiB64 }),
    signal: opts?.signal,
  });

  const text = await readBoundedText(res, MAX_SEAL_RESPONSE_BYTES);
  let body: unknown = {};
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error("invalid sealed lesson json");
    }
  }

  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: string }).error)
        : res.statusText;
    throw new Error(msg || "failed to seal protected lesson");
  }
  return parseSealResponse(body);
}

function requireB64Field(
  obj: Record<string, unknown>,
  key: string,
  max: number,
): string {
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
  const demo = o.demo;
  const content_alg = o.content_alg;
  const key_wrap = o.key_wrap;
  if (typeof lesson_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(lesson_id)) {
    throw new Error("invalid lesson_id");
  }
  if (typeof demo !== "string" || !demo || demo.length > 64) {
    throw new Error("invalid demo");
  }
  if (content_alg !== "AES-256-GCM") {
    throw new Error("unsupported content_alg");
  }
  if (key_wrap !== "RSA-OAEP-256") {
    throw new Error("unsupported key_wrap");
  }
  return {
    lesson_id,
    demo,
    content_alg,
    key_wrap,
    iv_b64: requireB64Field(o, "iv_b64", 64),
    ciphertext_b64: requireB64Field(o, "ciphertext_b64", Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 8),
    aad_b64: requireB64Field(o, "aad_b64", 4096),
    wrapped_key_b64: requireB64Field(o, "wrapped_key_b64", 512),
  };
}

/**
 * Unwrap AES content key via SubtleCrypto.unwrapKey only.
 * Raw AES bytes never surface as an application-level ArrayBuffer.
 */
export async function unwrapContentKey(
  privateKey: CryptoKey,
  wrappedKey: Uint8Array,
): Promise<CryptoKey> {
  if (wrappedKey.byteLength !== WRAPPED_KEY_LEN) {
    throw new Error("wrapped key must be 256 bytes");
  }
  return crypto.subtle.unwrapKey(
    "raw",
    asBufferSource(wrappedKey),
    privateKey,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: AES_LENGTH },
    false,
    ["decrypt"],
  );
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
      if (
        !Array.isArray(r.points) ||
        r.points.length === 0 ||
        r.points.length > MAX_POINTS_PER_STROKE
      ) {
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

export function buildAudit(
  rsaPrivate: CryptoKey,
  contentKey: CryptoKey,
  aesExportAttempt: "rejected",
): ProtectedLessonAudit {
  return {
    rsaPrivateExtractable: false,
    rsaPrivateUsages: Object.freeze([...(rsaPrivate.usages as KeyUsage[])]),
    aesExtractable: false,
    aesUsages: Object.freeze([...(contentKey.usages as KeyUsage[])]),
    aesExportAttempt,
    boundaryMode: "wasm-subtle-externref",
    keyBytesEnterWasmLinearMemory: false,
    plaintextReturnedAs: "js-arraybuffer",
  };
}

/**
 * Assert the actual unwrapped AES content key cannot be exported.
 * Returns the observed export-attempt result for the audit panel.
 */
export async function assertAesKeyNonExportable(
  key: CryptoKey,
): Promise<"rejected"> {
  if (key.extractable) {
    throw new Error("aes key unexpectedly extractable");
  }
  const usages = [...key.usages];
  if (usages.length !== 1 || usages[0] !== "decrypt") {
    throw new Error("aes key must be decrypt-only");
  }
  let rejected = false;
  try {
    await crypto.subtle.exportKey("raw", key);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("aes exportKey unexpectedly succeeded");
  }
  return "rejected";
}

/**
 * Full load path: RSA gen → seal request → unwrapKey → Wasm decrypt → validate.
 * CryptoKey handles are not returned; they fall out of scope after audit.
 */
export async function loadProtectedLesson(opts?: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<LoadProtectedLessonResult> {
  assertNotAborted(opts?.signal);
  const wasm = await ensureWasm();
  assertNotAborted(opts?.signal);

  const rsa = await generateLessonUnwrapKeys();
  const sealed = await fetchSealedLesson(rsa.publicKeySpkiB64, {
    fetchImpl: opts?.fetchImpl,
    signal: opts?.signal,
  });

  const iv = b64Decode(sealed.iv_b64);
  if (iv.byteLength !== IV_LEN) {
    throw new Error("iv must be 12 bytes");
  }
  const wrapped = b64Decode(sealed.wrapped_key_b64);
  if (wrapped.byteLength !== WRAPPED_KEY_LEN) {
    throw new Error("wrapped key must be 256 bytes");
  }
  const ciphertext = b64Decode(sealed.ciphertext_b64);
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error("ciphertext length out of bounds");
  }

  // Reconstruct canonical AAD; do not trust arbitrary server AAD for decrypt.
  const aad = canonicalAadBytes(sealed.lesson_id);
  if (aad.byteLength > MAX_AAD_BYTES) {
    throw new Error("aad length out of bounds");
  }
  const serverAad = b64Decode(sealed.aad_b64);
  if (
    serverAad.byteLength !== aad.byteLength ||
    !serverAad.every((b, i) => b === aad[i])
  ) {
    throw new Error("aad mismatch");
  }

  const contentKey = await unwrapContentKey(rsa.privateKey, wrapped);
  const aesExportAttempt = await assertAesKeyNonExportable(contentKey);
  if (contentKey.extractable !== false) {
    throw new Error("aes key unexpectedly extractable");
  }

  assertNotAborted(opts?.signal);

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

  const audit = buildAudit(rsa.privateKey, contentKey, aesExportAttempt);
  // contentKey and rsa.privateKey fall out of scope — not retained on the result.
  return { lesson, audit };
}
