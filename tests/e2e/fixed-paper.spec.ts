import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import { clearCases, clearEpisodic, makeSlice, seedCases, seedSlices } from "./memory-fixture";

const ref = "research/fixed-print";
const body = [
  "这是一份用于固定印刷测试的虚构文稿。来源见 things/paper-source。",
  ...Array.from({ length: 28 }, (_, i) => `## 第 ${i + 1} 节\n\n${"文字在纸上的大小与行长不跟随屏幕变化。缩放只改变看纸的距离，阅读可以从刚才的位置继续。".repeat(8)}`),
  `> ${"长引用也必须能跨纸张分页，不藏在无法到达的裁切中。".repeat(140)}`,
  "PRINT END MARKER",
].join("\n\n");

async function settlePaper(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.locator("[data-desk-stage]").evaluate((stage) =>
    stage.getAnimations({ subtree: true }).every((animation) => !animation.pending && animation.playState !== "running"),
  )).toBe(true);
  // Font loading can finish before the reader commits its measured count.
  // Require both the rendered count and the actual columns to settle.
  await expect.poll(() => page.evaluate(async () => {
    const snapshot = () => {
      const flow = document.querySelector<HTMLElement>(".desk-shell--top .desk-pages")!;
      return `${document.querySelector(".desk-page-position")?.textContent}:${flow.clientWidth}:${flow.scrollWidth}`;
    };
    const before = snapshot();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return before === snapshot();
  })).toBe(true);
}

async function paperRect(page: Page) {
  return page.locator(".desk-shell--top .desk-paper").evaluate((paper) => {
    const { x, y, width, height } = paper.getBoundingClientRect();
    return { x, y, width, height };
  });
}

async function expectWholePaperVisible(page: Page) {
  await expect.poll(() => page.locator(".desk-shell--top .desk-paper").evaluate((paper) => {
    const rect = paper.getBoundingClientRect();
    const stage = document.querySelector("[data-desk-stage]")!.getBoundingClientRect();
    return rect.left >= Math.max(0, stage.left) - 1 && rect.right <= Math.min(innerWidth, stage.right) + 1
      && rect.top >= Math.max(0, stage.top) - 1 && rect.bottom <= Math.min(innerHeight, stage.bottom) + 1;
  })).toBe(true);
}

async function openPaper(page: Page, pauseScene = false) {
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "PAPER" })]);
  await seedCases([
    { category: "research", name: "fixed-print", opened: "2026-02-01", body, pieces: [] },
    { category: "things", name: "paper-source", opened: "2026-02-01", body: "An original source.", pieces: [] },
  ]);
  await page.goto(pauseScene ? "/en/app" : "/en/app?view=field");
  if (pauseScene) {
    await page.locator("[data-game-manuscripts]").click();
    await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
  }
  await page.locator(`[data-archive-pile="${ref}"]`).click();
  await expect(page.locator(".desk-shell--top .desk-title")).toHaveText("fixed-print");
  await expect.poll(async () => Number((await page.locator(".desk-page-position").innerText()).split("/")[1])).toBeGreaterThan(2);
  await settlePaper(page);
}

async function printMetrics(page: Page) {
  return page.locator(".desk-shell--top").evaluate((shell) => {
    const paper = shell.querySelector<HTMLElement>(".desk-paper")!;
    const box = shell.querySelector<HTMLElement>(".desk-pagebox")!;
    const text = shell.querySelector<HTMLElement>(".typeset p")!;
    return {
      width: paper.offsetWidth, height: paper.offsetHeight,
      bodyWidth: box.clientWidth, bodyHeight: box.clientHeight,
      font: getComputedStyle(text).fontSize, leading: getComputedStyle(text).lineHeight,
      pages: document.querySelector(".desk-page-position")!.textContent!.split("/")[1].trim(),
    };
  });
}

test.describe("Fixed A4 reader", () => {
  test.afterEach(async () => { await clearCases(); await clearEpisodic(); });

  test("keeps print geometry and pagination through phone resize, zoom and page turns", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPaper(page);
    const desktop = await printMetrics(page);
    expect(desktop.width).toBeCloseTo(794, 0);
    expect(desktop.height).toBeCloseTo(1123, 0);
    await expectWholePaperVisible(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await settlePaper(page);
    await expect.poll(() => printMetrics(page)).toEqual(desktop);
    await expectWholePaperVisible(page);
    await page.locator("[data-zoom-in]").click();
    await page.locator("[data-zoom-in]").click();
    await settlePaper(page);
    expect(await printMetrics(page)).toEqual(desktop);
    const beforePan = await paperRect(page);
    await page.locator("[data-desk-field]").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await paperRect(page)).x).toBeLessThan(beforePan.x - 1);
    await expect.poll(async () => (await paperRect(page)).y).toBeLessThan(beforePan.y - 1);
    const afterPan = await paperRect(page);
    const wheelPoint = await page.locator(".desk-shell--top .desk-paper").evaluate((paper) => {
      const rect = paper.getBoundingClientRect();
      const stage = document.querySelector("[data-desk-stage]")!.getBoundingClientRect();
      return { x: (Math.max(rect.left, stage.left, 0) + Math.min(rect.right, stage.right, innerWidth)) / 2,
        y: (Math.max(rect.top, stage.top, 0) + Math.min(rect.bottom, stage.bottom, innerHeight)) / 2 };
    });
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    await page.mouse.wheel(0, -48);
    await expect.poll(async () => (await paperRect(page)).y).toBeGreaterThan(afterPan.y + 1);
    await expect(page.locator(".desk-page-position")).toHaveText(`1 / ${desktop.pages}`);
    await page.locator("[data-page-next]").click();
    await expect(page.locator(".desk-page-position")).toHaveText(`2 / ${desktop.pages}`);
    await settlePaper(page);
    expect(await printMetrics(page)).toEqual(desktop);
    await page.setViewportSize({ width: 320, height: 680 });
    await settlePaper(page);
    await expect.poll(() => printMetrics(page)).toEqual(desktop);
    await expect(page.locator(".desk-shell:not(.desk-shell--top):not([inert])")).toHaveCount(0);
  });

  test("reaches the end of a long quotation and preserves text selection and reference navigation", async ({ page }) => {
    await openPaper(page);
    const total = (await printMetrics(page)).pages;
    await page.locator("[data-page-prev]").click();
    await expect(page.locator(".desk-page-position")).toHaveText(`${total} / ${total}`);
    await settlePaper(page);
    const endIsVisible = await page.locator(".desk-shell--top").evaluate((shell) => {
      const box = shell.querySelector(".desk-pagebox")!.getBoundingClientRect();
      const stage = document.querySelector("[data-desk-stage]")!.getBoundingClientRect();
      const end = Array.from(shell.querySelectorAll("p")).find((p) => p.textContent === "PRINT END MARKER")!;
      const range = document.createRange();
      range.selectNodeContents(end);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      return rects.length > 0 && rects.every((r) =>
        r.left >= Math.max(box.left, stage.left, 0) - 1 && r.right <= Math.min(box.right, stage.right, innerWidth) + 1
        && r.top >= Math.max(box.top, stage.top, 0) - 1 && r.bottom <= Math.min(box.bottom, stage.bottom, innerHeight) + 1
        && end.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)),
      );
    });
    expect(endIsVisible).toBe(true);
    await page.locator("[data-page-next]").click();
    await expect(page.locator(".desk-page-position")).toHaveText(`1 / ${total}`);
    await page.locator('.desk-shell--top button[data-ref="things/paper-source"]').click();
    await expect(page.locator(".desk-shell--top .desk-title")).toHaveText("paper-source");
    await settlePaper(page);
    const paragraph = page.locator(".desk-shell--top .typeset p");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    const box = await paragraph.evaluate((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      const { x, y, width, height } = range.getClientRects()[0];
      return { x, y, width, height };
    });
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(100, box.width - 2), box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => paragraph.evaluate((p) => {
      const selection = getSelection();
      return selection && p.contains(selection.anchorNode) && p.contains(selection.focusNode) ? selection.toString().length : 0;
    })).toBeGreaterThan(0);
    await page.locator("[data-desk-close]").click();
    await expect(page.locator("[data-desk-field]")).toHaveCount(0);
  });

  test("keeps paper ink readable at night and respects index and editable keyboard boundaries", async ({ page }) => {
    await openPaper(page, true);
    await page.locator("[data-library-toggle]").click();
    await expect(page.locator("[data-library-panel]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-library-panel]")).toHaveCount(0);
    await expect(page.locator("[data-library-toggle]")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".desk-shell--top .desk-title")).toHaveText("fixed-print");
    await expect(page.locator("[data-desk-stack]")).toBeVisible();
    await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
    const before = await page.locator(".desk-page-position").innerText();
    // A focused external text field stands in for the independently mounted
    // conversation layer; the reader's window handler must not steal its keys.
    await page.evaluate(() => {
      const input = document.createElement("textarea");
      input.id = "paper-keyboard-fixture";
      input.value = "select and revise";
      input.style.cssText = "position:fixed;top:0;left:0;z-index:9999";
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    await expect(page.locator(".desk-page-position")).toHaveText(before);
    await expect(page.locator("[data-desk-field]")).toBeVisible();
    await page.evaluate(() => {
      document.querySelector("#paper-keyboard-fixture")?.remove();
      document.documentElement.classList.add("dark");
    });
    await expect(page.locator(".desk-shell--top .desk-paper")).toHaveCSS("color", "rgb(48, 59, 50)");
    await expect(page.locator(".desk-shell--top .desk-paper")).toHaveCSS("background-color", "rgb(234, 232, 218)");
  });

  test("does not restore a delayed cold-start document after a scene round trip", async ({ page }) => {
    test.slow();
    await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "RESTORE" })]);
    await seedCases([
      { category: "people", name: "user", opened: "2026-02-01", body: "A real fixture read that arrives after navigation.", pieces: [] },
    ]);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let intercepted = false;
    let responseHeld = false;
    let readFixtureConfirmed = false;
    await page.route("**/en/app**", async (route) => {
      const request = route.request();
      if (!intercepted && request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes('"people/user"')) {
        intercepted = true;
        // Read the real fixture through the server action, then delay only
        // delivery. Navigation below still uses the real shell and controls.
        const response = await route.fetch();
        readFixtureConfirmed = response.ok() && (await response.text()).includes("A real fixture read that arrives after navigation.");
        responseHeld = true;
        await readGate;
        await route.fulfill({ response });
      } else {
        await route.fallback();
      }
    });
    try {
      await page.goto("/en/app?view=field");
      await expect.poll(() => responseHeld).toBe(true);
      expect(readFixtureConfirmed).toBe(true);
      await page.locator("[data-scene-resume]").click();
      await expect(page.locator('[data-app-world="game"]')).toBeVisible();
      // The response remains held across BOTH moves. Checking only the
      // current world when it returns would incorrectly allow restoration.
      await page.keyboard.press("Control+.");
      await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
      const received = page.waitForResponse((response) => response.request().method() === "POST"
        && Boolean(response.request().headers()["next-action"])
        && Boolean(response.request().postData()?.includes('"people/user"')));
      releaseRead();
      await (await received).finished();
      await expect(page.locator('[data-archive-pile="people/user"]')).toBeVisible();
      // A stale restore mounts the desk after its 220ms handover. Observe
      // beyond that beat so an immediate negative assertion cannot pass.
      await page.waitForTimeout(700);
      await expect(page.locator("[data-desk-field]")).toHaveCount(0);
      await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
    } finally {
      releaseRead();
    }
  });
});
