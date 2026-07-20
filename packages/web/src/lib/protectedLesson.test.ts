import { describe, expect, it, vi } from "vitest";
import {
  assertAesKeyNonExportable,
  buildAudit,
  canonicalAadBytes,
  generateLessonUnwrapKeys,
  parseLessonJson,
  parseSealResponse,
  unwrapContentKey,
  validateLesson,
  WRAPPED_KEY_LEN,
} from "./protectedLesson";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

describe("protected lesson browser module", () => {
  it("generates non-extractable RSA private with unwrapKey only", async () => {
    const rsa = await generateLessonUnwrapKeys();
    expect(rsa.privateKey.extractable).toBe(false);
    expect([...rsa.privateKey.usages]).toEqual(["unwrapKey"]);
    expect(rsa.publicKeySpkiB64.length).toBeGreaterThan(100);
    const spki = Uint8Array.from(atob(rsa.publicKeySpkiB64), (c) =>
      c.charCodeAt(0),
    );
    expect(spki.byteLength).toBeGreaterThan(100);
  });

  it("unwraps AES via unwrapKey only as non-extractable decrypt-only", async () => {
    const rsa = await generateLessonUnwrapKeys();
    // Re-import public SPKI with wrapKey solely for the test wrap step.
    const spki = Uint8Array.from(atob(rsa.publicKeySpkiB64), (c) =>
      c.charCodeAt(0),
    );
    const wrapPub = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["wrapKey"],
    );
    const aes = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const wrappedBuf = await crypto.subtle.wrapKey(
      "raw",
      aes,
      wrapPub,
      { name: "RSA-OAEP" },
    );
    const wrapped = new Uint8Array(wrappedBuf);
    expect(wrapped.byteLength).toBe(WRAPPED_KEY_LEN);

    const contentKey = await unwrapContentKey(rsa.privateKey, wrapped);
    expect(contentKey.extractable).toBe(false);
    expect([...contentKey.usages]).toEqual(["decrypt"]);
    const exportResult = await assertAesKeyNonExportable(contentKey);
    expect(exportResult).toBe("rejected");
    await expect(crypto.subtle.exportKey("raw", contentKey)).rejects.toBeTruthy();
  });

  it("buildAudit reports actual-handle facts including export rejection", async () => {
    const rsa = await generateLessonUnwrapKeys();
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const audit = buildAudit(rsa.privateKey, key, "rejected");
    expect(audit.rsaPrivateExtractable).toBe(false);
    expect(audit.rsaPrivateUsages).toEqual(["unwrapKey"]);
    expect(audit.aesExtractable).toBe(false);
    expect(audit.aesUsages).toEqual(["decrypt"]);
    expect(audit.aesExportAttempt).toBe("rejected");
    expect(audit.boundaryMode).toBe("wasm-subtle-externref");
    expect(audit.keyBytesEnterWasmLinearMemory).toBe(false);
    expect(audit.plaintextReturnedAs).toBe("js-arraybuffer");
  });

  it("canonical AAD matches server contract", () => {
    const aad = new TextDecoder().decode(canonicalAadBytes("demo-slope-intro"));
    expect(aad).toBe(
      '{"v":1,"purpose":"protected-lesson","lesson_id":"demo-slope-intro"}',
    );
    expect(() => canonicalAadBytes("bad id")).toThrow();
  });

  it("validates lesson schema and bounds", () => {
    const good = {
      v: 1,
      id: "demo",
      title: "Title",
      steps: [
        {
          index: 0,
          label: "Step",
          strokes: [
            {
              color: "#0a0a0a",
              width: 2,
              points: [
                { x: 1, y: 2 },
                { x: 3, y: 4 },
              ],
            },
          ],
        },
      ],
    };
    expect(validateLesson(good).id).toBe("demo");
    expect(() => validateLesson({ ...good, v: 2 })).toThrow();
    expect(() => validateLesson({ ...good, steps: [] })).toThrow();
  });

  it("requires dense ordered nonnegative integer step indexes", () => {
    const stroke = {
      color: "#0a0a0a",
      width: 2,
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    };
    const two = {
      v: 1,
      id: "demo",
      title: "Title",
      steps: [
        { index: 0, label: "A", strokes: [stroke] },
        { index: 1, label: "B", strokes: [stroke] },
      ],
    };
    expect(validateLesson(two).steps).toHaveLength(2);

    expect(() =>
      validateLesson({
        ...two,
        steps: [
          { index: 0, label: "A", strokes: [stroke] },
          { index: 3, label: "B", strokes: [stroke] },
        ],
      }),
    ).toThrow(/index order/);

    expect(() =>
      validateLesson({
        ...two,
        steps: [
          { index: 1, label: "A", strokes: [stroke] },
          { index: 0, label: "B", strokes: [stroke] },
        ],
      }),
    ).toThrow(/index order/);

    expect(() =>
      validateLesson({
        ...two,
        steps: [{ index: -1, label: "A", strokes: [stroke] }],
      }),
    ).toThrow(/step index/);

    expect(() =>
      validateLesson({
        ...two,
        steps: [{ index: 1.5, label: "A", strokes: [stroke] }],
      }),
    ).toThrow(/step index/);

    expect(() =>
      validateLesson({
        ...two,
        steps: [{ label: "A", strokes: [stroke] }],
      }),
    ).toThrow(/step index/);
  });

  it("parseLessonJson rejects oversized payloads", () => {
    const huge = new TextEncoder().encode("x".repeat(20 * 1024));
    expect(() => parseLessonJson(huge.buffer)).toThrow(/bounds/);
  });

  it("parseSealResponse enforces stable typed shape without title", () => {
    const ok = parseSealResponse({
      lesson_id: "demo-slope-intro",
      demo: "protected-lesson",
      content_alg: "AES-256-GCM",
      key_wrap: "RSA-OAEP-256",
      iv_b64: b64(new Uint8Array(12)),
      ciphertext_b64: b64(new Uint8Array(32)),
      aad_b64: b64(new Uint8Array(8)),
      wrapped_key_b64: b64(new Uint8Array(256)),
    });
    expect(ok.lesson_id).toBe("demo-slope-intro");
    expect(ok.demo).toBe("protected-lesson");
    expect(() =>
      parseSealResponse({
        lesson_id: "x",
        demo: "protected-lesson",
        content_alg: "AES-128-GCM",
        key_wrap: "RSA-OAEP-256",
        iv_b64: "aa",
        ciphertext_b64: "bb",
        aad_b64: "cc",
        wrapped_key_b64: "dd",
      }),
    ).toThrow(/content_alg/);
    expect(() =>
      parseSealResponse({
        lesson_id: "demo-slope-intro",
        demo: "other-demo",
        content_alg: "AES-256-GCM",
        key_wrap: "RSA-OAEP-256",
        iv_b64: b64(new Uint8Array(12)),
        ciphertext_b64: b64(new Uint8Array(32)),
        aad_b64: b64(new Uint8Array(8)),
        wrapped_key_b64: b64(new Uint8Array(256)),
      }),
    ).toThrow(/demo/);
  });

  it("rejects wrong wrapped key length before unwrap", async () => {
    const rsa = await generateLessonUnwrapKeys();
    await expect(unwrapContentKey(rsa.privateKey, new Uint8Array(16))).rejects.toThrow(
      /256/,
    );
  });
});

describe("protected lesson fetch wiring", () => {
  it("fetchSealedLesson bounds body then parses JSON", async () => {
    const { fetchSealedLesson } = await import("./protectedLesson");
    const body = {
      lesson_id: "demo-slope-intro",
      demo: "protected-lesson",
      content_alg: "AES-256-GCM",
      key_wrap: "RSA-OAEP-256",
      iv_b64: b64(new Uint8Array(12)),
      ciphertext_b64: b64(new Uint8Array(48)),
      aad_b64: b64(new Uint8Array(16)),
      wrapped_key_b64: b64(new Uint8Array(256)),
    };
    const text = JSON.stringify(body);
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-length"
              ? String(text.length)
              : null,
        },
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (done) return { done: true, value: undefined };
                done = true;
                return {
                  done: false,
                  value: new TextEncoder().encode(text),
                };
              },
              cancel: async () => undefined,
            };
          },
        },
        text: async () => text,
      } as unknown as Response;
    });
    const sealed = await fetchSealedLesson("AAAA", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/demo/protected-lesson");
    expect((init as RequestInit).method).toBe("POST");
    expect(sealed.lesson_id).toBe("demo-slope-intro");
  });

  it("fetchSealedLesson rejects oversized Content-Length", async () => {
    const { fetchSealedLesson, MAX_SEAL_RESPONSE_BYTES } = await import(
      "./protectedLesson"
    );
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        statusText: "OK",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-length"
              ? String(MAX_SEAL_RESPONSE_BYTES + 1)
              : null,
        },
        body: null,
        text: async () => "{}",
      } as unknown as Response;
    });
    await expect(
      fetchSealedLesson("AAAA", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/too large/);
  });
});
