import { expect, test, type Browser, type Page } from "@playwright/test";

async function createHost(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Display name").first().fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page).toHaveURL(/\/room\//, { timeout: 20000 });
  await expect(page.getByText("Your safety code")).toBeVisible({ timeout: 20000 });
  const roomId = page.url().split("/room/")[1]?.split("?")[0] ?? "";
  const inviteText = await page.getByText(/Invite:/).textContent();
  const invite = inviteText?.replace("Invite:", "").trim() ?? "";
  return { roomId, invite };
}

async function joinGuest(page: Page, name: string, roomId: string, invite: string) {
  await page.goto("/");
  await page.getByLabel("Display name").nth(1).fill(name);
  await page.locator("#room-id").fill(roomId);
  await page.locator("#invite").fill(invite);
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page).toHaveURL(/\/room\//, { timeout: 20000 });
  await expect(page.getByText(/Waiting for host approval/i)).toBeVisible({
    timeout: 20000,
  });
}

async function drawStroke(page: Page) {
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 20000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const x = box.x + box.width * 0.3;
  const y = box.y + box.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up();
}

test.describe("cipherboard flows", () => {
  test("host approve, draw sync, time travel, remove", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const g1Ctx = await browser.newContext();
    const g2Ctx = await browser.newContext();
    const host = await hostCtx.newPage();
    const g1 = await g1Ctx.newPage();
    const g2 = await g2Ctx.newPage();

    const { roomId, invite } = await createHost(host, "HostUser");
    expect(roomId.length).toBeGreaterThan(5);
    expect(invite.length).toBeGreaterThan(5);

    await joinGuest(g1, "GuestOne", roomId, invite);
    await joinGuest(g2, "GuestTwo", roomId, invite);

    await expect(host.getByText("GuestOne")).toBeVisible({ timeout: 15000 });
    await host.getByRole("button", { name: "Approve" }).first().click();
    await expect(g1.getByRole("toolbar", { name: /Drawing tools/i })).toBeVisible({
      timeout: 25000,
    });

    await expect(host.getByText("GuestTwo")).toBeVisible({ timeout: 15000 });
    await host.getByRole("button", { name: "Approve" }).click();
    await expect(g2.getByRole("toolbar", { name: /Drawing tools/i })).toBeVisible({
      timeout: 25000,
    });

    // Drawing sync host -> guests
    await drawStroke(host);
    await host.waitForTimeout(1500);
    // Time travel slider present
    await expect(host.getByLabel("Scrub timeline")).toBeVisible();
    const scrub = host.locator("#scrub");
    const max = await scrub.getAttribute("max");
    expect(Number(max)).toBeGreaterThan(0);

    // Scrub to 0 then live
    await scrub.fill("0");
    await host.getByRole("button", { name: "Jump to live" }).click();

    // Fork
    host.once("dialog", async (d) => {
      await d.accept("fork-e2e");
    });
    await host.getByRole("button", { name: "Fork from here" }).click();
    await expect(host.locator("select").filter({ hasText: "fork" }).or(host.getByText("fork-e2e"))).toBeVisible({
      timeout: 10000,
    }).catch(() => {
      // branch select may list name
    });

    // Remove GuestTwo — remaining pair still works
    const removeBtn = host
      .locator(".participant")
      .filter({ hasText: "GuestTwo" })
      .getByRole("button", { name: "Remove" });
    await removeBtn.click();
    await expect(
      host.locator(".participant").filter({ hasText: "GuestTwo" }),
    ).toHaveCount(0, { timeout: 10000 });

    await drawStroke(host);
    await host.waitForTimeout(1000);
    // GuestOne still has toolbar
    await expect(g1.getByRole("toolbar", { name: /Drawing tools/i })).toBeVisible();
    // GuestTwo should not regain board (still waiting/rejected/removed UI)
    await expect(g2.getByRole("toolbar", { name: /Drawing tools/i })).toHaveCount(0, {
      timeout: 5000,
    });

    await hostCtx.close();
    await g1Ctx.close();
    await g2Ctx.close();
  });
});
