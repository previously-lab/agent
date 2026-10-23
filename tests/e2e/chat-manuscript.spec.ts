import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import { clearEpisodic, makeSlice, seedSlices } from "./memory-fixture";

async function openConversation(page: Page) {
  const expand = page.getByRole("button", { name: "Expand to full screen" });
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  const textarea = page.locator(".conversation-composer textarea");
  await expect(expand.or(retry).or(textarea).first()).toBeVisible({ timeout: 30_000 });
  if (await retry.isVisible()) await retry.click();
  await expect(expand.or(textarea).first()).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  await expect(textarea).toBeVisible();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-panel-tier", "fullscreen");
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
]) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
    });

    test.afterEach(async () => { await clearEpisodic(); });

    test("the manuscript stays readable and keeps the draft and attachment when folded", async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const at = new Date().toISOString();
      const slice = makeSlice(at, { tag: "MANUSCRIPT" });
      delete slice.closedBy;
      delete slice.end;
      slice.turns = [
        { role: "user", at, content: "Manuscript question: can we keep the room's original context?" },
        { role: "agent", at, content: "Manuscript answer: the room holds what we knew together at that moment.\n\nLater documents can add perspective while the original conversation keeps its place." },
      ];
      await seedSlices([slice]);
      await page.goto("/en/app");
      await openConversation(page);

      const user = page.locator("[data-conversation-turn][data-role=user]").filter({ hasText: "Manuscript question:" });
      const agent = page.locator("[data-conversation-turn]").filter({ hasText: "Manuscript answer:" });
      await expect(user).toBeVisible();
      await expect(agent).toBeVisible();
      await expect(user.locator(".conversation-speaker")).toHaveText("You");
      await expect(agent.locator(".conversation-speaker")).toHaveText("Previously");

      const userBody = await user.locator(".conversation-turn-content").boundingBox();
      const agentBody = await agent.locator(".conversation-turn-content").boundingBox();
      expect(userBody).not.toBeNull();
      expect(agentBody).not.toBeNull();
      expect(Math.abs(userBody!.x - agentBody!.x)).toBeLessThan(1);
      expect(Math.abs(userBody!.width - agentBody!.width)).toBeLessThan(1);
      expect(agentBody!.x).toBeGreaterThanOrEqual(0);
      expect(agentBody!.x + agentBody!.width).toBeLessThanOrEqual(viewport.width);
      expect(await agent.locator(".conversation-prose").evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      const byline = await agent.locator(".conversation-byline").boundingBox();
      if (viewport.mobile) expect(byline!.y + byline!.height).toBeLessThanOrEqual(agentBody!.y);
      else expect(byline!.x + byline!.width).toBeLessThan(agentBody!.x);

      const input = page.getByRole("textbox", { name: "Send a message..." });
      const draft = "This draft stays with me when I return to the room.";
      await input.fill(draft);
      await page.locator(".conversation-composer input[type=file]").setInputFiles({
        name: "fixture-note.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64"),
      });
      await expect(page.getByRole("button", { name: "Remove attachment: fixture-note.png" })).toBeVisible();
      await input.press("Escape");
      await expect(page.locator("[data-pill-composer]")).toBeVisible();
      await expect(page.getByRole("button", { name: "Exit full screen" })).toHaveCount(0);
      await expect(input).toHaveValue(draft);
      expect(await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      const pill = await page.locator(".conversation-composer--pill").boundingBox();
      expect(pill!.x).toBeGreaterThanOrEqual(0);
      expect(pill!.x + pill!.width).toBeLessThanOrEqual(viewport.width);

      await page.getByRole("button", { name: "Expand to full screen" }).click();
      await expect(input).toHaveValue(draft);
      const remove = page.getByRole("button", { name: "Remove attachment: fixture-note.png" });
      await expect(remove).toBeVisible();
      await remove.click();
      await expect(remove).toHaveCount(0);
      await expect(input).toHaveValue(draft);
      await expect.poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      const screenshot = await page.screenshot({ path: testInfo.outputPath("manuscript.png") });
      await testInfo.attach("manuscript", { body: screenshot, contentType: "image/png" });
    });
  });
}
