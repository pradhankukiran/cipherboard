import { expect, test, type Page } from "@playwright/test";

function captureWs(page: Page) {
  const sent: string[] = [];
  const received: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const msg = JSON.parse(String(payload)) as {
          type?: string;
          envelopes?: unknown[];
        };
        sent.push(`${msg.type ?? "unknown"}:${msg.envelopes?.length ?? "-"}`);
      } catch {
        sent.push("non-json");
      }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const msg = JSON.parse(String(payload)) as {
          type?: string;
          seq?: number;
          message?: string;
        };
        received.push(
          `${msg.type ?? "unknown"}:${msg.seq ?? "-"}:${msg.message ?? "-"}`,
        );
      } catch {
        received.push("non-json");
      }
    });
  });
  return { sent, received, pageErrors };
}

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
  await canvas.evaluate((element) => {
    element.dataset.pointerDownCount = "0";
    element.dataset.pointerMoveCount = "0";
    element.dataset.pointerUpCount = "0";
    element.addEventListener("pointerdown", () => {
      element.dataset.pointerDownCount = String(
        Number(element.dataset.pointerDownCount ?? "0") + 1,
      );
    });
    element.addEventListener("pointermove", () => {
      element.dataset.pointerMoveCount = String(
        Number(element.dataset.pointerMoveCount ?? "0") + 1,
      );
    });
    element.addEventListener("pointerup", () => {
      element.dataset.pointerUpCount = String(
        Number(element.dataset.pointerUpCount ?? "0") + 1,
      );
    });
  });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const x = box.x + box.width * 0.3;
  const y = box.y + box.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up();
  const hit = await page.evaluate(
    ({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        tag: element?.tagName ?? null,
        className: element?.className ?? null,
      };
    },
    { x, y },
  );
  return {
    box,
    hit,
    nativeCounts: await canvas.evaluate((element) => ({
      down: element.dataset.pointerDownCount,
      move: element.dataset.pointerMoveCount,
      up: element.dataset.pointerUpCount,
    })),
  };
}

/** Timeline scrub max reflects durable events on the active branch. */
async function scrubMax(page: Page): Promise<number> {
  const scrub = page.locator("#scrub");
  await expect(scrub).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => Number((await scrub.getAttribute("max")) ?? "0"), {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  return Number((await scrub.getAttribute("max")) ?? "0");
}

test.describe("cipherboard flows", () => {
  test("host approve, draw sync, time travel, remove", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const g1Ctx = await browser.newContext();
    const g2Ctx = await browser.newContext();
    const host = await hostCtx.newPage();
    const g1 = await g1Ctx.newPage();
    const g2 = await g2Ctx.newPage();
    const hostWs = captureWs(host);
    const g1Ws = captureWs(g1);

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

    // Drawing sync host -> GuestOne (observable timeline advance)
    const g1Before = Number((await g1.locator("#scrub").getAttribute("max")) ?? "0");
    const firstDraw = await drawStroke(host);
    try {
      await expect
        .poll(
          async () =>
            Number((await g1.locator("#scrub").getAttribute("max")) ?? "0"),
          { timeout: 20000 },
        )
        .toBeGreaterThan(g1Before);
    } catch (cause) {
      const hostErrors = await host.locator(".error-box").allTextContents();
      const guestErrors = await g1.locator(".error-box").allTextContents();
      const hostTopbar = await host.locator(".topbar").innerText();
      const hostScrubValue = await host.locator("#scrub").inputValue();
      throw new Error(
        `[DEBUG-cb-sync] firstDraw=${JSON.stringify(firstDraw)} hostTopbar=${JSON.stringify(hostTopbar)} hostScrubValue=${JSON.stringify(hostScrubValue)} hostPageErrors=${JSON.stringify(hostWs.pageErrors)} hostSent=${JSON.stringify(hostWs.sent)} hostRecv=${JSON.stringify(hostWs.received)} guestRecv=${JSON.stringify(g1Ws.received)} hostErrors=${JSON.stringify(hostErrors)} guestErrors=${JSON.stringify(guestErrors)}`,
        { cause },
      );
    }

    const hostMax = await scrubMax(host);
    expect(hostMax).toBeGreaterThan(0);

    // Scrub to 0 then live
    await host.locator("#scrub").fill("0");
    await host.getByRole("button", { name: "Jump to live" }).click();
    await expect(host.getByText(/live/i)).toBeVisible();

    // Fork: wait for option fork-e2e, select it, inherited timeline non-empty
    host.once("dialog", async (d) => {
      await d.accept("fork-e2e");
    });
    await host.getByRole("button", { name: "Fork from here" }).click();

    const branchSelect = host.locator("label", { hasText: "Branch" }).locator("select");
    await expect(branchSelect.locator('option', { hasText: "fork-e2e" })).toHaveCount(1, {
      timeout: 15000,
    });
    const forkValue = await branchSelect
      .locator('option', { hasText: "fork-e2e" })
      .getAttribute("value");
    expect(forkValue).toBeTruthy();
    await branchSelect.selectOption(forkValue!);
    await expect(branchSelect).toHaveValue(forkValue!);
    // Inherited parent strokes keep timeline non-empty on the fork
    await expect
      .poll(async () => Number((await host.locator("#scrub").getAttribute("max")) ?? "0"), {
        timeout: 15000,
      })
      .toBeGreaterThan(0);

    // Remove GuestTwo — remaining pair still works
    const removeBtn = host
      .locator(".participant")
      .filter({ hasText: "GuestTwo" })
      .getByRole("button", { name: "Remove" });
    await removeBtn.click();
    await expect(
      host.locator(".participant").filter({ hasText: "GuestTwo" }),
    ).toHaveCount(0, { timeout: 10000 });

    // Switch host back to main for post-remove draw (fork may be selected)
    const mainOpt = branchSelect.locator("option").first();
    const mainVal = await mainOpt.getAttribute("value");
    if (mainVal) await branchSelect.selectOption(mainVal);

    const g1Mid = Number((await g1.locator("#scrub").getAttribute("max")) ?? "0");
    await drawStroke(host);
    await expect
      .poll(async () => Number((await g1.locator("#scrub").getAttribute("max")) ?? "0"), {
        timeout: 20000,
      })
      .toBeGreaterThan(g1Mid);

    await expect(g1.getByRole("toolbar", { name: /Drawing tools/i })).toBeVisible();
    await expect(g2.getByRole("toolbar", { name: /Drawing tools/i })).toHaveCount(0, {
      timeout: 5000,
    });

    await hostCtx.close();
    await g1Ctx.close();
    await g2Ctx.close();
  });
});
