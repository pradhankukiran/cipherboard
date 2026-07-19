import { expect, test } from "@playwright/test";

/**
 * Multi-context smoke: host creates room, guest requests join, host approves.
 * Requires a running server at PLAYWRIGHT_BASE_URL (default http://127.0.0.1:8080).
 * In Docker build this runs against the locally started server with Postgres.
 */
test.describe("cipherboard room flow", () => {
  test("host and guest waiting room", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();

    await host.goto("/");
    await expect(host.getByRole("heading", { name: /encrypted whiteboard/i })).toBeVisible();

    await host.getByLabel("Display name").first().fill("HostUser");
    await host.getByRole("button", { name: "Create room" }).click();

    await expect(host).toHaveURL(/\/room\//, { timeout: 15000 });
    await expect(host.getByText("Your safety code")).toBeVisible({ timeout: 15000 });

    const roomId = host.url().split("/room/")[1]?.split("?")[0] ?? "";
    expect(roomId.length).toBeGreaterThan(5);

    const inviteText = await host.getByText(/Invite:/).textContent();
    const invite = inviteText?.replace("Invite:", "").trim() ?? "";
    expect(invite.length).toBeGreaterThan(5);

    await guest.goto("/");
    await guest.getByLabel("Display name").nth(1).fill("GuestUser");
    await guest.locator("#room-id").fill(roomId);
    await guest.locator("#invite").fill(invite);
    await guest.getByRole("button", { name: "Request access" }).click();

    await expect(guest).toHaveURL(/\/room\//, { timeout: 15000 });
    await expect(guest.getByText(/Waiting for host approval/i)).toBeVisible({
      timeout: 15000,
    });

    await expect(host.getByText("GuestUser")).toBeVisible({ timeout: 15000 });
    await host.getByRole("button", { name: "Approve" }).click();

    await expect(guest.getByRole("toolbar", { name: /Drawing tools/i })).toBeVisible({
      timeout: 20000,
    });
    await expect(host.getByText("GuestUser")).toBeVisible();

    await hostCtx.close();
    await guestCtx.close();
  });
});
