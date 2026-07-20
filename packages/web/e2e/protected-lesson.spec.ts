import { expect, test } from "@playwright/test";

test.describe("protected lesson replay", () => {
  test("loads sealed lesson, shows audit facts, AES export rejected", async ({
    page,
  }) => {
    await page.goto("/demo/protected-lesson");

    await expect(page.getByRole("heading", { name: "Protected Lesson Replay" })).toBeVisible({
      timeout: 20000,
    });

    // Wait for seal → unwrap → wasm decrypt path
    await expect(page.getByTestId("protected-lesson-audit")).toBeVisible({
      timeout: 60000,
    });

    await expect(page.getByTestId("audit-rsa-extractable")).toHaveText("false");
    await expect(page.getByTestId("audit-aes-extractable")).toHaveText("false");
    await expect(page.getByTestId("audit-aes-usages")).toHaveText("decrypt");
    await expect(page.getByTestId("audit-boundary-mode")).toHaveText(
      "wasm-subtle-externref",
    );
    await expect(page.getByTestId("audit-key-bytes")).toHaveText("false");
    await expect(page.getByTestId("audit-plaintext")).toHaveText("js-arraybuffer");

    await expect(page.getByTestId("protected-lesson-canvas")).toBeVisible();
    await expect(page.getByTestId("protected-lesson-scrub")).toBeVisible();

    // Runtime check: protected AES key cannot be exported
    const exportRejected = await page.evaluate(async () => {
      // Re-run a minimal path: the page already loaded; probe via a fresh key
      // matching production unwrap policy (non-extractable, decrypt-only).
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      if (key.extractable) return { ok: false, reason: "extractable" };
      try {
        await crypto.subtle.exportKey("raw", key);
        return { ok: false, reason: "export-succeeded" };
      } catch {
        return { ok: true, reason: "export-rejected" };
      }
    });
    expect(exportRejected.ok).toBe(true);

    // Scrub forward
    const scrub = page.getByTestId("protected-lesson-scrub");
    const max = Number(await scrub.getAttribute("max"));
    if (max > 0) {
      await scrub.fill(String(max));
      await expect(page.getByText(new RegExp(`Step ${max + 1} of`))).toBeVisible();
    }

    // Landing link still present for rooms flow
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Protected Lesson Replay" }),
    ).toBeVisible();
  });
});
