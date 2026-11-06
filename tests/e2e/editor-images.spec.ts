import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { E2E_MEMORY_ROOT } from "./env";
import { clearCases, clearEpisodic, makeSlice, seedSlices } from "./memory-fixture";
import { imageFile, imageId, imageSnapshot, mockPhotoReads, mockUploads, replySse } from "./editor-images-fixture";

const input = (page: Page) => page.locator("[data-manuscript-input]");
const composer = (page: Page) => page.locator("[data-manuscript-composer]");
const photos = (page: Page) => composer(page).locator("figure[data-image-asset]");
async function open(page: Page) {
  await clearEpisodic(); await page.goto("/en/app");
  await expect(input(page)).toBeVisible({ timeout: 30_000 });
  await input(page).fill("A place I want to remember. ");
}
async function attach(page: Page, names: string[]) {
  await page.locator("input[type=file]").setInputFiles(names.map(imageFile));
}
test.afterEach(async () => { await clearCases(); await clearEpisodic(); });

for (const view of [
  { name: "desktop", width: 1440, height: 1000, touch: false, reduce: false },
  { name: "mobile", width: 390, height: 844, touch: true, reduce: false },
  { name: "reduced-motion", width: 1440, height: 1000, touch: false, reduce: true },
  { name: "dark", width: 1440, height: 1000, touch: false, reduce: true },
]) test.describe(view.name, () => {
  test.use({ viewport: { width: view.width, height: view.height }, isMobile: view.touch, hasTouch: view.touch });
  test("unframed editor exposes floating actions and the uploaded photo stack", async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: view.reduce ? "reduce" : "no-preference" });
    await mockUploads(page); await open(page);
    if (view.name === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
    const original = await input(page).elementHandle();
    await page.locator("[data-composer-tools-trigger]").click();
    await expect(page.locator("[data-attach]:visible")).toBeVisible();
    await expect(page.locator("[data-document-mention]:visible")).toBeVisible();
    await attach(page, ["coast.svg", "evening.svg"]);
    await expect(photos(page)).toHaveCount(2);
    await expect(input(page)).toHaveAttribute("data-editor-text", "A place I want to remember. 〔图1〕〔图2〕");
    await expect(input(page)).toHaveCount(1);
    expect(await input(page).evaluate((el, before) => el === before, original)).toBe(true);
    await expect(composer(page)).toHaveCSS("box-shadow", "none");
    await expect(composer(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator("[data-conversation-controls]")).toHaveCSS("position", "relative");
    await expect(page.locator("[data-composer-send]")).toBeEnabled();
    await expect(page.locator("[data-composer-keyboard-caption]")).toContainText("Enter to send");
    const toolbarBox = await page.locator("[data-conversation-primary]").boundingBox();
    expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(view.width);
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(view.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (view.touch) {
      const bounds = await page.locator("[data-composer-send]").boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
      const readHits = () => composer(page).locator(".conversation-photo-index button").evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        return { label: button.getAttribute("aria-label"), hits: [2, box.height / 2, box.height - 2].map(offset => {
          const target = document.elementFromPoint(box.x + box.width / 2, box.y + offset);
          return { ownButton: Boolean(target && button.contains(target)), hit: target?.getAttribute("aria-label") ?? target?.className };
        }) };
      }));
      // The full-screen shell animates into its seat on entry; assert the
      // settled interactive surface, not a frame whose pointer mask is closed.
      await expect.poll(async () => (await readHits()).flatMap(result => result.hits.map(hit => hit.ownButton))).toEqual([true, true, true, true, true, true]);
      const hitTests = await readHits();
      console.log("Mobile photo index hit tests:", JSON.stringify(hitTests));
      expect(hitTests.flatMap(result => result.hits.map(hit => hit.ownButton))).toEqual([true, true, true, true, true, true]);
    }
    if (view.reduce) await expect(photos(page).first()).toHaveCSS("animation-name", "none");
    await input(page).focus();
    await expect.poll(() => photos(page).locator("img").first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    // Screenshots are stable after the one-shot arrival, without hiding UI.
    await photos(page).last().evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const target = process.env.AFTRBREZ_QA_OUTPUT ? path.join(process.env.AFTRBREZ_QA_OUTPUT, `editor-${view.name}.png`) : info.outputPath(`editor-${view.name}.png`);
    await page.screenshot({ path: target, style: "nextjs-portal { visibility: hidden !important; }" });
    await info.attach(view.name, { path: target, contentType: "image/png" });
  });
});

test("image-only paste waits for composition, and drop adds exactly one later marker", async ({ page }) => {
  await mockUploads(page); await open(page);
  await input(page).dispatchEvent("compositionstart", { data: "pinyin" });
  const fixture = imageFile("coast.svg").buffer.toString();
  await input(page).evaluate((element, svg) => {
    const data = new DataTransfer(); data.items.add(new File([svg], "coast.svg", { type: "image/svg+xml" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, fixture);
  await expect(photos(page)).toHaveCount(0);
  await expect(input(page)).toHaveAttribute("data-editor-text", "A place I want to remember. ");
  await input(page).dispatchEvent("compositionend", { data: "拼音" });
  await expect(photos(page)).toHaveCount(1);
  await composer(page).evaluate((element, svg) => {
    const data = new DataTransfer(); data.items.add(new File([svg], "evening.svg", { type: "image/svg+xml" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, fixture);
  await expect(photos(page)).toHaveCount(2);
  await expect(input(page)).toHaveAttribute("data-editor-text", "A place I want to remember. 〔图1〕〔图2〕");
});

test("upload success alone flies; reverse completion, removal and retry keep stable ordinals", async ({ page }) => {
  await mockPhotoReads(page);
  const pending = new Map<string, () => Promise<void>>();
  let firstAttempts = 0;
  await page.route("**/api/attachments/upload", async route => {
    const name = /filename="([^"]+)"/.exec(route.request().postData() ?? "")![1];
    if (name === "one.svg" && ++firstAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: "Fixture upload unavailable" } }); return;
    }
    await new Promise<void>(resolve => pending.set(name, async () => {
      await route.fulfill({ status: 201, json: { attachment: imageSnapshot(name === "one.svg" ? 1 : 2, name) } }); resolve();
    }));
  });
  await open(page); await attach(page, ["one.svg", "two.svg"]);
  await expect(composer(page).locator('[data-upload-state="error"]')).toHaveCount(1);
  await expect(photos(page)).toHaveCount(0);
  await expect(page.locator("[data-composer-send]")).toBeDisabled();
  await expect.poll(() => pending.has("two.svg")).toBe(true); await pending.get("two.svg")!();
  await expect(photos(page)).toHaveCount(1);
  await expect(photos(page)).toHaveAttribute("data-image-ordinal", "2");
  await composer(page).getByRole("button", { name: "Retry upload" }).click();
  await expect.poll(() => pending.has("one.svg")).toBe(true); await pending.get("one.svg")!();
  await expect(photos(page)).toHaveCount(2);
  // Select the earlier marker: the front photo changes without stealing the caret.
  await input(page).focus();
  await input(page).locator('[data-image-reference]').first().click();
  await expect(composer(page).locator('[data-image-ordinal="1"]')).toHaveAttribute("data-image-selected", "true");
  await expect(input(page)).toBeFocused();
  await composer(page).getByRole("button", { name: "Remove attachment: one.svg" }).click();
  await expect(photos(page)).toHaveCount(1);
  await expect(photos(page)).toHaveAttribute("data-image-ordinal", "2");
  await composer(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => firstAttempts).toBe(3); await pending.get("one.svg")!();
  await expect(photos(page)).toHaveCount(2);
  await expect(composer(page).locator('[data-image-ordinal="1"]')).toHaveCount(1);
});

test("HTTP acceptance transfers only frozen photos and preserves ABA edits before reply completion", async ({ page }) => {
  await mockUploads(page); await open(page); await attach(page, ["coast.svg"]);
  await expect(photos(page)).toHaveCount(1);
  // A deterministic browser response exposes the actual acceptance/stream
  // boundary; no backend model request or arbitrary sleep is involved.
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    const state = window as unknown as { acceptChat: () => void; finishChat: () => void; chatBody: unknown };
    window.fetch = async (url, init) => {
      if (url !== "/api/chat" || init?.method !== "POST") return originalFetch(url, init);
      state.chatBody = JSON.parse(init.body as string);
      return new Promise<Response>(resolve => {
        state.acceptChat = () => resolve(new Response(new ReadableStream({ start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"start","messageId":"held-reply"}\n\ndata: {"type":"text-start","id":"text"}\n\n'));
          state.finishChat = () => { controller.enqueue(encoder.encode('data: {"type":"text-delta","id":"text","delta":"Accepted fixture reply"}\n\ndata: {"type":"text-end","id":"text"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n')); controller.close(); };
        } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
      });
    };
  });
  const text = (await input(page).getAttribute("data-editor-text"))!;
  await input(page).press("Enter");
  await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "stop");
  await expect(photos(page)).toHaveCount(1); // HTTP acceptance has not transferred the frozen photo yet.
  await input(page).fill(""); await input(page).fill(text); // Same text, different draft revision.
  await page.evaluate(() => (window as unknown as { acceptChat: () => void }).acceptChat());
  await expect(photos(page)).toHaveCount(0);
  await expect(input(page)).toHaveAttribute("data-editor-text", text);
  await input(page).press("Control+z");
  await expect(input(page)).toHaveAttribute("data-editor-text", text); // Acceptance cleared only undo, not the ABA draft.
  await expect(page.locator("[data-composer-stop]")).toBeVisible();
  const posted = await page.evaluate(() => (window as unknown as { chatBody: { stagedAttachments: unknown; persona: string; messages: { parts: { type: string }[] }[] } }).chatBody);
  expect(posted.persona).toBe("user");
  expect(posted.stagedAttachments).toEqual([{ assetId: imageId(1), ordinal: 1 }]);
  expect(posted.messages.at(-1)!.parts.some(part => part.type === "file")).toBe(false);
  await page.evaluate(() => (window as unknown as { finishChat: () => void }).finishChat());
  await expect(page.getByText("Accepted fixture reply", { exact: true })).toBeVisible();
  const sent = page.locator('[data-conversation-turn][data-role="user"]');
  await expect(sent).toHaveCount(1);
  await sent.locator("[data-image-reference]").click();
  await expect(sent.locator("figure[data-image-asset]")).toBeFocused();
});

test("rejected sends retain the draft and retry one stable message without a duplicate paragraph", async ({ page }) => {
  await mockUploads(page); await open(page); await attach(page, ["coast.svg"]);
  await expect(photos(page)).toHaveCount(1);
  const bodies: { messages: { id: string }[] }[] = [];
  await page.route("**/api/chat", route => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1 ? route.fulfill({ status: 503, json: { error: "Fixture refusal" } })
      : route.fulfill({ contentType: "text/event-stream", body: replySse("Retry accepted") });
  });
  const text = (await input(page).getAttribute("data-editor-text"))!;
  await input(page).press("Enter");
  await expect(page.locator("[data-composer-send]")).toBeEnabled();
  await expect(input(page)).toHaveAttribute("data-editor-text", text); await expect(photos(page)).toHaveCount(1);
  await expect(page.locator('[data-conversation-turn][data-role="user"]')).toHaveCount(0);
  await input(page).press("Control+Enter");
  await expect(page.getByText("Retry accepted", { exact: true })).toBeVisible();
  await expect(input(page)).toHaveAttribute("data-editor-text", ""); await expect(photos(page)).toHaveCount(0);
  await input(page).press("Control+z"); await expect(input(page)).toHaveAttribute("data-editor-text", "");
  await expect(page.locator('[data-conversation-turn][data-role="user"]')).toHaveCount(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[0].messages.at(-1)!.id).toBe(bodies[1].messages.at(-1)!.id);
});

test("history refresh and record reader share referenced photos and an unreferenced appendix", async ({ page }) => {
  const at = "2026-02-01T09:00:00.000Z";
  const slice = makeSlice(at, { tag: "PHOTO-READER" });
  slice.turns[0].content = "The coast appears here 〔图2〕. The other photograph belongs in the appendix.";
  await seedSlices([slice]);
  // This fixture edits only the already guarded, isolated test record.
  const core = path.join(E2E_MEMORY_ROOT, "records", ...slice.id.split("-"), "core.md");
  const attachments = [1, 2].map(n => ({ ...imageSnapshot(n, `photo-${n}.svg`, `records/${slice.id.replaceAll("-", "/")}/photo-${n}.svg`), ordinal: n }));
  const envelope = encodeURIComponent(JSON.stringify({ version: 1, attachments }));
  const source = await readFile(core, "utf8");
  await writeFile(core, source.replace(`(${slice.turns[0].role})\n`, `(${slice.turns[0].role}) [attachments ${envelope}] [body-escaped v1]\n`), "utf8");
  await mockPhotoReads(page); await page.goto("/en/app");
  const live = page.locator('[data-conversation-turn][data-role="user"]').filter({ hasText: "The coast appears here" });
  await expect(live.locator("figure[data-image-asset]")).toHaveCount(2);
  await expect(live.locator(".conversation-image-annex [data-image-ordinal='1']")).toHaveCount(1);
  await live.locator("[data-image-reference]").click(); await expect(live.locator('[data-image-ordinal="2"]')).toBeFocused();
  await page.reload(); await expect(live.locator("figure[data-image-asset]")).toHaveCount(2);
  await page.goto(`/en/app?doc=records/${slice.id}`);
  const record = page.locator('.desk-shell--top .document-record-turn[data-turn-role="user"]');
  await expect(record.locator("figure[data-image-asset]")).toHaveCount(2);
  await record.locator("[data-image-reference]").click(); await expect(record.locator('[data-image-ordinal="2"]')).toBeFocused();
  expect(await record.locator("img").evaluateAll(images => images.map(image => image.getAttribute("src")))).toEqual(attachments.slice().reverse().map(image => `/api/attachments?ref=${encodeURIComponent(image.ref)}&persona=user`));
});
