import { test, expect } from "./test";
import type { Page, TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearCases, clearEpisodic } from "./memory-fixture";
import { imageId, replySse } from "./editor-images-fixture";

const editor = (page: Page) => page.locator("[data-manuscript-input]");
const primary = (page: Page) => page.locator("[data-conversation-primary]");
const draftPhotos = (page: Page) => page.locator("[data-manuscript-composer] figure");
const prose = "今天沿着海边慢慢走，想把两段光线留在这里。横幅是傍晚的海面，竖幅是路边的小树。图片引用应完整留在正文中，中文也应自然换行。";
type Box = { x: number; y: number; width: number; height: number };

async function fixturePng(page: Page, width: number, height: number) {
  const encoded = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#a3c7d1"; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#f9d08c"; ctx.beginPath(); ctx.arc(width * .7, height * .25, width * .13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#55776c"; ctx.fillRect(0, height * .65, width, height * .35);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width, height });
  return Buffer.from(encoded, "base64");
}

async function installViewportFixture(page: Page) {
  // Explicitly synthetic: this exercises browser events/geometry, not a real
  // mobile OS keyboard. Device keyboard acceptance remains a manual check.
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const target = window as unknown as { setFixtureViewport: (height: number, offsetTop: number) => void };
    target.setFixtureViewport = (height, offsetTop) => {
      Object.assign(viewport, { height, offsetTop });
      viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
    };
  });
}

async function installHeldChat(page: Page) {
  await page.route("**/api/chat/controls-parallel-*/stream*", route => route.fulfill({ contentType: "text/event-stream", body: replySse("并行回复已完成") }));
  await page.evaluate(() => {
    const original = window.fetch;
    const state = window as unknown as { acceptFixtureChat: () => void; emitFixtureText: () => void; fixturePosts: unknown[] };
    state.fixturePosts = [];
    window.fetch = async (url, init) => {
      if (url !== "/api/chat" || init?.method !== "POST") return original(url, init);
      state.fixturePosts.push(JSON.parse(init.body as string));
      if (state.fixturePosts.length > 1) return new Response(null, { status: 200, headers: { "x-workflow-run-id": `controls-parallel-${state.fixturePosts.length}` } });
      return new Promise<Response>(resolve => {
        state.acceptFixtureChat = () => resolve(new Response(new ReadableStream({ start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"start","messageId":"controls-held"}\n\ndata: {"type":"text-start","id":"text"}\n\n'));
          state.emitFixtureText = () => controller.enqueue(encoder.encode('data: {"type":"text-delta","id":"text","delta":"正在读这两张照片。"}\n\n'));
        } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
      });
    };
  });
}

test.afterEach(async ({ page }) => {
  // The arrival gate may still have a background action in flight at teardown.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await clearCases(); await clearEpisodic();
});

for (const view of [
  { name: "desktop", width: 1440, height: 1000, mobile: false, reduced: false },
  { name: "phone-zh", width: 390, height: 844, mobile: true, reduced: false },
  { name: "reduced-motion", width: 390, height: 844, mobile: true, reduced: true },
]) test.describe(view.name, () => {
  test.use({ viewport: { width: view.width, height: view.height }, isMobile: view.mobile, hasTouch: view.mobile });
  test("one editor-anchored primary survives photo states, scrolling, handoff and parallel sends", async ({ page }, info: TestInfo) => {
    await clearEpisodic(); await installViewportFixture(page);
    await page.emulateMedia({ reducedMotion: view.reduced ? "reduce" : "no-preference" });
    const out = process.env.AFTRBREZ_QA_OUTPUT ?? info.outputDir;
    await mkdir(out, { recursive: true });
    let releaseArrival!: () => void;
    const arrivalGate = new Promise<void>(resolve => { releaseArrival = resolve; });
    await page.route("**/zh/app", async route => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        const response = await route.fetch();
        if (/"mode":"(?:resume|briefing)"/.test(await response.text())) await arrivalGate;
        await route.fulfill({ response });
      } else await route.fallback();
    });
    await page.goto("/zh/app");
    await expect(page.locator("[data-primary-placeholder]")).toBeVisible();
    await expect(page.locator("body > [data-conversation-controls]")).toHaveCount(0);
    await expect(page.locator("[data-conversation-controls]")).toHaveCSS("position", "relative");
    const loadingBox = (await primary(page).boundingBox())!;
    if (view.name === "phone-zh") await page.screenshot({ path: path.join(out, "mobile-editor-phone-zh-loading.png"), style: "nextjs-portal { visibility: hidden !important; }" });
    releaseArrival();
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await expect(primary(page)).toHaveCount(1); await expect(primary(page)).toBeDisabled();
    const original = await primary(page).elementHandle();
    const baseline = (await primary(page).boundingBox())!;
    const metrics: { phase: string; primary: Box; photos: Box[] }[] = [{ phase: "loading", primary: loadingBox, photos: [] }];
    async function checkpoint(phase: string) {
      expect(await primary(page).evaluate((el, before) => el === before, original)).toBe(true);
      // In-flow controls may begin beyond the fold after photos or prose grow;
      // ordinary scrolling must reveal them without changing their anchor.
      await primary(page).scrollIntoViewIfNeeded();
      const box = (await primary(page).boundingBox())!;
      const anchor = await primary(page).evaluate(el => {
        const controls = el.closest("[data-conversation-controls]")!;
        const composer = el.closest("[data-manuscript-composer]")!;
        const input = composer.querySelector("[data-manuscript-input]")!;
        const inputBox = input.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        const primaryBox = el.getBoundingClientRect();
        return {
          position: getComputedStyle(controls).position,
          bodyPortal: controls.parentElement === document.body,
          belowInput: primaryBox.y >= inputBox.bottom,
          rightDelta: Math.abs(primaryBox.right - composerBox.right),
          insideComposer: primaryBox.bottom <= composerBox.bottom,
        };
      });
      expect(anchor, `${phase}: editor anchor`).toEqual({ position: "relative", bodyPortal: false, belowInput: true, rightDelta: 0, insideComposer: true });
      const viewport = page.viewportSize()!;
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator("[data-companion-pod]:visible")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const photos = await draftPhotos(page).locator("[data-photo-media]").evaluateAll(nodes => nodes.map(node => {
        const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height };
      }));
      metrics.push({ phase, primary: box, photos });
      if (view.name === "phone-zh" || phase === "ready") {
        const file = path.join(out, `mobile-editor-${view.name}-${phase}.png`);
        await page.screenshot({ path: file, style: "nextjs-portal { visibility: hidden !important; }" });
        await info.attach(phase, { path: file, contentType: "image/png" });
      }
    }
    await expect(page.locator(".pulse-delay:visible")).toHaveCount(0);
    await checkpoint("empty");
    expect(await editor(page).evaluate(el => JSON.parse(getComputedStyle(el, "::before").content))).toBe(await editor(page).getAttribute("data-placeholder"));
    await expect(page.locator("[data-composer-tools-trigger]")).toHaveCSS("opacity", "0");
    // Keyboard can discover the initially concealed tools; no send/expand ambiguity.
    await page.locator("[data-composer-tools-trigger]").focus();
    await expect(page.locator("[data-composer-tools-trigger]")).toHaveCSS("opacity", "1");
    await editor(page).fill(prose);
    await page.locator("[data-composer-tools-trigger]").click();
    await expect(page.locator("[data-attach]")).toBeVisible();
    await expect(page.locator("[data-document-mention]")).toBeVisible();
    await checkpoint("editing");
    const buffers = [await fixturePng(page, 360, 240), await fixturePng(page, 240, 360)];
    const uploads = new Map<string, (fail?: boolean) => Promise<void>>();
    const reads: (() => Promise<void>)[] = [];
    let releasePhotoReads = false;
    await page.route("**/api/attachments/upload/*/cancel?*", route => route.fulfill({ json: { cancelled: true } }));
    await page.route("**/api/attachments/upload", async route => {
      const name = /filename="([^"]+)"/.exec(route.request().postData() ?? "")![1];
      const n = name === "wide.png" ? 1 : 2;
      await new Promise<void>(resolve => uploads.set(name, async fail => {
        if (fail) await route.fulfill({ status: 503, json: { error: "Fixture upload unavailable" } });
        else await route.fulfill({ status: 201, json: { attachment: { version: 1, assetId: imageId(n), ref: `drafts/${imageId(n)}`, name, mediaType: "image/png", width: n === 1 ? 360 : 240, height: n === 1 ? 240 : 360 } } });
        resolve();
      }));
    });
    await page.route("**/api/attachments?*", async route => {
      const n = decodeURIComponent(route.request().url()).includes(imageId(2)) ? 1 : 0;
      if (releasePhotoReads) { await route.fulfill({ contentType: "image/png", body: buffers[n] }); return; }
      await new Promise<void>(resolve => reads.push(async () => { await route.fulfill({ contentType: "image/png", body: buffers[n] }); resolve(); }));
    });
    await page.locator("input[type=file]").setInputFiles(buffers.map((buffer, n) => ({ name: n ? "portrait.png" : "wide.png", mimeType: "image/png", buffer })));
    await expect.poll(() => uploads.size).toBe(2);
    await expect(draftPhotos(page).locator("[data-photo-media]")).toHaveCount(2);
    await expect(primary(page)).toBeDisabled();
    await checkpoint("uploading");
    await uploads.get("portrait.png")!(true); uploads.delete("portrait.png");
    await expect(page.locator('[data-upload-state="error"]')).toHaveCount(1);
    await checkpoint("upload-error");
    await page.locator('[data-upload-state="error"] .conversation-photo-status button').click();
    await expect.poll(() => uploads.has("portrait.png")).toBe(true);
    await uploads.get("wide.png")!(); await uploads.get("portrait.png")!();
    await expect.poll(() => reads.length).toBe(2);
    await expect(page.locator("[data-manuscript-composer] [data-image-arrival]")).toHaveCount(0);
    await checkpoint("decoding");
    await page.evaluate(() => {
      const originalDecode = HTMLImageElement.prototype.decode;
      const state = window as unknown as { decodeHolds: { src: string; resolve: () => void }[]; restoreFixtureDecode: () => void };
      state.decodeHolds = [];
      state.restoreFixtureDecode = () => { HTMLImageElement.prototype.decode = originalDecode; };
      HTMLImageElement.prototype.decode = async function () {
        await originalDecode.call(this);
        if (this.src.includes("/api/attachments?")) await new Promise<void>(resolve => state.decodeHolds.push({ src: this.src, resolve }));
      };
    });
    for (const release of reads.splice(0)) await release();
    await expect.poll(() => page.evaluate(() => (window as unknown as { decodeHolds: unknown[] }).decodeHolds.length)).toBe(2);
    // A stale decode from the old source must not finish the replacement.
    const portrait = page.locator(`[data-manuscript-composer] figure[data-image-asset="${imageId(2)}"]`);
    await portrait.locator("img").evaluate(el => el.dispatchEvent(new Event("error", { bubbles: false })));
    await expect(portrait).toHaveAttribute("data-preview-state", "error");
    await checkpoint("preview-error");
    await portrait.locator(".conversation-photo-status button").click();
    await expect.poll(() => reads.length).toBe(1); await reads.shift()!();
    await expect.poll(() => page.evaluate(() => (window as unknown as { decodeHolds: unknown[] }).decodeHolds.length)).toBe(3);
    await page.evaluate(() => { for (const held of (window as unknown as { decodeHolds: { resolve: () => void }[] }).decodeHolds.slice(0, 2)) held.resolve(); });
    await expect(portrait).toHaveAttribute("data-preview-state", "loading");
    await checkpoint("preview-retry");
    await page.evaluate(() => (window as unknown as { decodeHolds: { resolve: () => void }[] }).decodeHolds[2].resolve());
    await expect(page.locator('[data-manuscript-composer] figure[data-preview-state="ready"]')).toHaveCount(2);
    releasePhotoReads = true;
    await page.evaluate(() => (window as unknown as { restoreFixtureDecode: () => void }).restoreFixtureDecode());
    await expect(editor(page).locator('[contenteditable="false"][data-image-reference]')).toHaveCount(2);
    await draftPhotos(page).last().evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    await checkpoint("ready");
    const uploading = metrics.find(item => item.phase === "uploading")!.photos;
    const ready = metrics.find(item => item.phase === "ready")!.photos;
    for (let n = 0; n < 2; n++) expect(Math.abs(uploading[n].height - ready[n].height)).toBeLessThan(3);
    expect(await editor(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (view.reduced) await expect(draftPhotos(page).last()).toHaveCSS("animation-name", "none");

    // A long draft reserves a real controls row. Scrolling moves the editor and
    // primary together; there is no fixed seat trying to hold the viewport.
    await editor(page).fill(`${prose}\n\n${Array.from({ length: 10 }, (_, n) => `长正文段落 ${n + 1}：输入区继续自然增长，发送控件始终留在正文之后。`).join("\n\n")}`);
    await checkpoint("long-draft");
    const field = page.locator("[data-conversation-field]");
    const beforeScroll = await page.evaluate(() => ({
      scrollTop: document.querySelector("[data-conversation-field]")!.scrollTop,
      primaryY: document.querySelector("[data-conversation-primary]")!.getBoundingClientRect().y,
      editorY: document.querySelector("[data-manuscript-input]")!.getBoundingClientRect().y,
    }));
    await field.evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - Math.min(240, el.clientHeight / 3)); });
    await expect.poll(() => field.evaluate(el => el.scrollTop)).toBeLessThan(beforeScroll.scrollTop);
    const afterScroll = await page.evaluate(() => ({
      primaryY: document.querySelector("[data-conversation-primary]")!.getBoundingClientRect().y,
      editorY: document.querySelector("[data-manuscript-input]")!.getBoundingClientRect().y,
    }));
    expect(afterScroll.primaryY).toBeGreaterThan(beforeScroll.primaryY);
    expect(Math.abs((afterScroll.primaryY - afterScroll.editorY) - (beforeScroll.primaryY - beforeScroll.editorY))).toBeLessThan(1);
    const scrolledShot = path.join(out, `mobile-editor-${view.name}-scrolled.png`);
    await page.screenshot({ path: scrolledShot, style: "nextjs-portal { visibility: hidden !important; }" });
    await info.attach("scrolled", { path: scrolledShot, contentType: "image/png" });
    await field.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => (await primary(page).boundingBox())!.y).toBe(beforeScroll.primaryY);

    // Synthetic visualViewport events must not move the in-flow control. Real
    // mobile keyboards keep using the browser's native visual scrolling.
    const keyboardBaseline = (await primary(page).boundingBox())!.y;
    await page.evaluate(() => (window as unknown as { setFixtureViewport: (h: number, top: number) => void }).setFixtureViewport(innerHeight * .55, 30));
    await expect.poll(async () => (await primary(page).boundingBox())!.y).toBe(keyboardBaseline);
    await checkpoint("simulated-keyboard");
    await page.evaluate(() => (window as unknown as { setFixtureViewport: (h: number, top: number) => void }).setFixtureViewport(innerHeight, 0));
    await expect.poll(async () => (await primary(page).boundingBox())!.y).toBe(keyboardBaseline);
    await installHeldChat(page);
    await primary(page).click();
    await expect(primary(page)).toHaveAttribute("data-primary-action", "stop");
    await checkpoint("handoff");
    await page.evaluate(() => (window as unknown as { acceptFixtureChat: () => void }).acceptFixtureChat());
    await expect(editor(page)).toHaveAttribute("data-editor-text", "");
    await checkpoint("waiting-reply");
    await page.evaluate(() => (window as unknown as { emitFixtureText: () => void }).emitFixtureText());
    await expect(page.getByText("正在读这两张照片。", { exact: true })).toBeVisible();
    await checkpoint("streaming");
    await editor(page).fill("同时补充一条新的观察。");
    await page.locator("[data-composer-tools-trigger]").click();
    await expect(page.locator("[data-composer-secondary-send]")).toBeEnabled();
    await page.locator("[data-composer-secondary-send]").click();
    await expect(editor(page)).toHaveAttribute("data-editor-text", "");
    await expect(primary(page)).toHaveAttribute("data-primary-action", "stop");
    await editor(page).fill("键盘仍可继续发送。"); await editor(page).press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixturePosts: unknown[] }).fixturePosts.length)).toBe(3);
    await expect(editor(page)).toHaveAttribute("data-editor-text", "");
    await checkpoint("parallel");
    await primary(page).click();
    await expect(primary(page)).toHaveAttribute("data-primary-action", "send");
    await checkpoint("stopped");
    await writeFile(path.join(out, `mobile-editor-${view.name}-geometry.json`), JSON.stringify({ syntheticViewport: true, baseline, metrics }, null, 2));
  });
});
