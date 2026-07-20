import { expect, test } from "@playwright/test";

test.describe("protected lesson replay", () => {
  test("loads sealed lesson and shows actual-key export audit", async ({
    page,
  }) => {
    await page.goto("/demo/protected-lesson");

    await expect(
      page.getByRole("heading", { name: "Protected Lesson Replay" }),
    ).toBeVisible({ timeout: 20000 });

    // Ready only after load path ran assertAesKeyNonExportable on the real key.
    await expect(page.getByTestId("protected-lesson-audit")).toBeVisible({
      timeout: 60000,
    });

    await expect(page.getByTestId("audit-rsa-extractable")).toHaveText("false");
    await expect(page.getByTestId("audit-rsa-usages")).toHaveText("unwrapKey");
    await expect(page.getByTestId("audit-aes-extractable")).toHaveText("false");
    await expect(page.getByTestId("audit-aes-usages")).toHaveText("decrypt");
    await expect(page.getByTestId("audit-aes-export")).toHaveText("rejected");
    await expect(page.getByTestId("audit-boundary-mode")).toHaveText(
      "wasm-subtle-externref",
    );
    await expect(page.getByTestId("audit-key-bytes")).toHaveText("false");
    await expect(page.getByTestId("audit-plaintext")).toHaveText(
      "js-arraybuffer",
    );

    await expect(page.getByTestId("protected-lesson-canvas")).toBeVisible();
    await expect(page.getByTestId("protected-lesson-scrub")).toBeVisible();

    const scrub = page.getByTestId("protected-lesson-scrub");
    const max = Number(await scrub.getAttribute("max"));
    if (max > 0) {
      await scrub.fill(String(max));
      await expect(page.getByText(new RegExp(`Step ${max + 1} of`))).toBeVisible();
    }

    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Protected Lesson Replay" }),
    ).toBeVisible();
  });

  test("fails closed when sealed ciphertext is tampered", async ({ page }) => {
    await page.route("**/api/demo/protected-lesson", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, string>;
      const ct = json.ciphertext_b64;
      if (typeof ct === "string" && ct.length > 4) {
        // Flip a base64 payload character so AES-GCM auth fails after unwrap.
        const chars = ct.split("");
        const i = Math.max(0, chars.length - 8);
        chars[i] = chars[i] === "A" ? "B" : "A";
        json.ciphertext_b64 = chars.join("");
      }
      await route.fulfill({
        status: response.status(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(json),
      });
    });

    await page.goto("/demo/protected-lesson");
    await expect(page.getByTestId("protected-lesson-error")).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByTestId("protected-lesson-audit")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("fails closed when sealed AAD is tampered", async ({ page }) => {
    await page.route("**/api/demo/protected-lesson", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, string>;
      // Corrupt AAD so browser canonical check or GCM auth fails closed.
      json.aad_b64 = btoa('{"v":1,"purpose":"protected-lesson","lesson_id":"forged"}');
      await route.fulfill({
        status: response.status(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(json),
      });
    });

    await page.goto("/demo/protected-lesson");
    await expect(page.getByTestId("protected-lesson-error")).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByTestId("protected-lesson-audit")).toHaveCount(0);
  });
});
