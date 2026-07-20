import { describe, expect, it, vi } from "vitest";
import {
  assertAesKeyNonExportable,
  buildAudit,
  generateLessonUnwrapKeys,
  parseLessonJson,
  parseSealResponse,
  unwrapContentKeyDirect,
  validateLesson,
} from "./protectedLesson";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

describe("protected lesson browser module", () => {
  it("generates non-extractable RSA private key and exportable public SPKI", async () => {
    const rsa = await generateLessonUnwrapKeys();
    expect(rsa.privateKey.extractable).toBe(false);
    expect(rsa.publicKeySpkiB64.length).toBeGreaterThan(100);
    // Public SPKI export is how the browser sends the wrap key to the server.
    const spki = Uint8Array.from(atob(rsa.publicKeySpkiB64), (c) => c.charCodeAt(0));
    expect(spki.byteLength).toBeGreaterThan(100);
  });

  it("unwraps AES content key as non-extractable decrypt-only", async () => {
    const rsa = await generateLessonUnwrapKeys();
    // Create a real AES key, wrap with RSA public, unwrap with private.
    const aes = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const raw = await crypto.subtle.exportKey("raw", aes);
    const wrapped = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      rsa.publicKey,
      raw,
    );
    const contentKey = await unwrapContentKeyDirect(rsa.privateKey, b64(new Uint8Array(wrapped)));
    expect(contentKey.extractable).toBe(false);
    expect([...contentKey.usages]).toEqual(["decrypt"]);
    await assertAesKeyNonExportable(contentKey);
    await expect(crypto.subtle.exportKey("raw", contentKey)).rejects.toBeTruthy();
  });

  it("buildAudit reports truthful boundary facts", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const audit = buildAudit(key);
    expect(audit.rsaPrivateExtractable).toBe(false);
    expect(audit.aesExtractable).toBe(false);
    expect(audit.aesUsages).toEqual(["decrypt"]);
    expect(audit.boundaryMode).toBe("wasm-subtle-externref");
    expect(audit.keyBytesEnterWasmLinearMemory).toBe(false);
    expect(audit.plaintextReturnedAs).toBe("js-arraybuffer");
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
    expect(() =>
      validateLesson({
        ...good,
        steps: [
          {
            index: 0,
            label: "x",
            strokes: [{ color: "red", width: 1, points: [{ x: 0, y: 0 }] }],
          },
        ],
      }),
    ).toThrow();
  });

  it("parseLessonJson rejects oversized payloads", () => {
    const huge = new TextEncoder().encode("x".repeat(20 * 1024));
    expect(() => parseLessonJson(huge.buffer)).toThrow(/bounds/);
  });

  it("parseSealResponse enforces stable typed shape", () => {
    const ok = parseSealResponse({
      lesson_id: "demo-slope-intro",
      title: "Title",
      content_alg: "AES-256-GCM",
      key_wrap: "RSA-OAEP-256",
      iv_b64: b64(new Uint8Array(12)),
      ciphertext_b64: b64(new Uint8Array(32)),
      aad_b64: b64(new Uint8Array(8)),
      wrapped_key_b64: b64(new Uint8Array(256)),
    });
    expect(ok.lesson_id).toBe("demo-slope-intro");
    expect(() =>
      parseSealResponse({
        lesson_id: "x",
        title: "t",
        content_alg: "AES-128-GCM",
        key_wrap: "RSA-OAEP-256",
        iv_b64: "aa",
        ciphertext_b64: "bb",
        aad_b64: "cc",
        wrapped_key_b64: "dd",
      }),
    ).toThrow(/content_alg/);
  });

  it("tampered ciphertext fails AES-GCM decrypt (host path control)", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode('{"v":1}');
    const pt = new TextEncoder().encode('{"v":1,"id":"x","title":"t","steps":[]}');
    // encrypt needs encrypt usage — generate extractable encrypt+decrypt for control
    const encKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        encKey,
        pt,
      ),
    );
    const bad = new Uint8Array(ct);
    bad[bad.length - 1] ^= 0x01;
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        encKey,
        bad,
      ),
    ).rejects.toBeTruthy();
    // unused key silence
    expect(key.algorithm).toBeTruthy();
  });
});

describe("protected lesson fetch wiring", () => {
  it("fetchSealedLesson posts SPKI and parses JSON", async () => {
    const { fetchSealedLesson } = await import("./protectedLesson");
    const body = {
      lesson_id: "demo-slope-intro",
      title: "Slope",
      content_alg: "AES-256-GCM",
      key_wrap: "RSA-OAEP-256",
      iv_b64: b64(new Uint8Array(12)),
      ciphertext_b64: b64(new Uint8Array(48)),
      aad_b64: b64(new Uint8Array(16)),
      wrapped_key_b64: b64(new Uint8Array(256)),
    };
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        json: async () => body,
      } as Response;
    });
    const sealed = await fetchSealedLesson("AAAA", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/demo/protected-lesson");
    expect((init as RequestInit).method).toBe("POST");
    expect(sealed.lesson_id).toBe("demo-slope-intro");
  });
});
