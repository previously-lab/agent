import { test, expect } from "./test";
import type { Locator, Page } from "@playwright/test";
import { clearCases, clearEpisodic } from "./memory-fixture";
import { imageFile, mockUploads, replySse } from "./editor-images-fixture";

const editor = (page: Page) => page.locator('[data-testid="manuscript-editor"]');
const photos = (page: Page) => page.locator('[data-manuscript-composer] figure[data-image-asset]');
const text = (input: Locator, value: string) => expect(input).toHaveAttribute("data-editor-text", value);

async function beforeInput(input: Locator, inputType: string) {
  // Playwright's generic dispatchEvent fallback constructs Event for this
  // name; EventInit silently discards inputType. Use the browser's InputEvent.
  return input.evaluate((element, type) => element.dispatchEvent(new InputEvent("beforeinput", {
    inputType: type, bubbles: true, cancelable: true,
  })), inputType);
}

async function open(page: Page) {
  await clearEpisodic(); await mockUploads(page); await page.goto("/en/app");
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
}

/** DOM ranges count serialized badge markers, matching the public plain-text
 * contract. Tests never mutate component state or reach into React internals. */
async function select(input: Locator, start: number, end = start) {
  await input.focus();
  await input.evaluate((element, offsets) => {
    function point(at: number): { node: Node; offset: number } {
      for (const node of element.childNodes) {
        const size = node.textContent?.length ?? 0;
        if (node.nodeType === Node.TEXT_NODE && at <= size) return { node, offset: at };
        if (node instanceof HTMLElement && node.hasAttribute("data-editor-atom") && at < size)
          return { node: element, offset: Array.from(element.childNodes).indexOf(node) + (at > 0 ? 1 : 0) };
        at -= size;
      }
      return { node: element, offset: element.childNodes.length };
    }
    const a = point(offsets.start), b = point(offsets.end);
    getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    document.dispatchEvent(new Event("selectionchange"));
  }, { start, end });
}

test.afterEach(async () => { await clearCases(); await clearEpisodic(); });

test("verified badge is atomic; backspace, delete and undo preserve adjacent prose and the photo", async ({ page }) => {
  await open(page); const input = editor(page);
  const root = await input.elementHandle();
  await input.fill("left right"); await select(input, 1, 4);
  await page.locator("[data-composer-tools-trigger]").click();
  const choosing = page.waitForEvent("filechooser");
  await page.locator("[data-attach]:visible").click();
  await (await choosing).setFiles(imageFile("one.svg"));
  const badge = input.locator('[data-image-reference]');
  await expect(badge).toHaveAttribute("contenteditable", "false");
  await text(input, "left〔图1〕 right");
  await expect(photos(page)).toHaveCount(1);
  await select(input, 8); await input.press("Backspace");
  await text(input, "left right"); await expect(badge).toHaveCount(0); await expect(photos(page)).toHaveCount(1);
  await input.press("Control+z"); await text(input, "left〔图1〕 right");
  await select(input, 4); await input.press("Delete"); await text(input, "left right");
  await input.press("Control+z"); await text(input, "left〔图1〕 right");
  await input.press("Control+Shift+z"); await text(input, "left right");
  await input.press("Control+z"); await badge.click();
  await expect(photos(page)).toHaveAttribute("data-image-selected", "true");
  await expect(input).toBeFocused();
  await input.press("Backspace"); await text(input, "left right");
  await input.press("Control+z");
  await badge.focus(); await badge.press("Delete");
  await text(input, "left right"); await expect(input).toBeFocused();
  await input.pressSequentially("!"); await text(input, "left! right");
  expect(await input.evaluate((element, original) => element === original, root)).toBe(true);
  await input.fill("literal 〔图999〕 and 〔图01〕");
  await expect(badge).toHaveCount(0); await text(input, "literal 〔图999〕 and 〔图01〕");
});

test("clipboard serializes badges predictably and accepts only plain text from outside HTML", async ({ page }) => {
  await open(page); const input = editor(page);
  await input.fill("left right"); await select(input, 4);
  await page.locator('input[type="file"]').setInputFiles(imageFile("one.svg"));
  await expect(input.locator('[data-image-reference]')).toHaveCount(1);
  await select(input, 4, 8);
  const copied = await input.evaluate(element => {
    const clipboard = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return { plain: clipboard.getData("text/plain"), html: clipboard.getData("text/html") };
  });
  expect(copied).toEqual({ plain: "〔图1〕", html: "" });
  const cut = await input.evaluate(element => {
    const clipboard = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return clipboard.getData("text/plain");
  });
  expect(cut).toBe("〔图1〕"); await text(input, "left right"); await expect(photos(page)).toHaveCount(1);
  await input.press("Control+z"); await text(input, "left〔图1〕 right");
  await select(input, 0, 14);
  await input.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "<b>literal</b>\n〔图999〕");
    clipboard.setData("text/html", '<img src=x onerror="window.badPaste=true"><b>not plaintext</b><span contenteditable=false data-editor-atom="fake">fake</span>');
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await text(input, "<b>literal</b>\n〔图999〕");
  await expect(input.locator("img,b,script,[data-editor-atom]")).toHaveCount(0);
  await input.press("Control+z"); await text(input, "left〔图1〕 right");
});

test("actual Chromium IME keeps its node during composition and commits one undoable edit", async ({ page }) => {
  await open(page); const input = editor(page);
  let posts = 0;
  await page.route("**/api/chat", route => { posts++; return route.fulfill({ contentType: "text/event-stream", body: replySse("fixture") }); });
  await input.fill("prefix "); await select(input, 7);
  const root = await input.elementHandle();
  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", { text: "拼音", selectionStart: 2, selectionEnd: 2 });
  const composingNode = await input.evaluateHandle(element => element.firstChild);
  // A tier/parent update must not rewrite the live IME text node.
  await page.locator("[data-composer-tools-trigger]").dispatchEvent("click");
  await expect(page.locator("[data-composer-tools]")).toBeVisible();
  await input.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
  expect(posts).toBe(0);
  expect(await input.evaluate((element, original) => element.firstChild === original, composingNode)).toBe(true);
  await client.send("Input.insertText", { text: "拼音" });
  await text(input, "prefix 拼音");
  expect(await input.evaluate((element, original) => element === original, root)).toBe(true);
  await input.press("Control+z"); await text(input, "prefix ");
  await input.press("Control+Shift+z"); await text(input, "prefix 拼音");
  await input.press("Shift+Enter"); await input.pressSequentially("new line");
  await text(input, "prefix 拼音\nnew line"); expect(posts).toBe(0);
  await input.press("Enter"); await expect.poll(() => posts).toBe(1); await text(input, "");
  await input.press("Control+z"); await text(input, "");
  await client.detach();
});

test.describe("phone input events", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("beforeinput deletes a whole reference, historyUndo restores it, and mobile send runs once", async ({ page }) => {
    await open(page); const input = editor(page);
    let posted: unknown;
    await page.route("**/api/chat", route => { posted = route.request().postDataJSON(); return route.fulfill({ contentType: "text/event-stream", body: replySse("mobile fixture") }); });
    await input.fill("left right"); await select(input, 4);
    await page.locator('input[type="file"]').setInputFiles(imageFile("one.svg"));
    await expect(input.locator('[data-image-reference]')).toHaveCount(1);
    await select(input, 8);
    expect(await beforeInput(input, "deleteContentBackward")).toBe(false);
    await text(input, "left right"); await expect(photos(page)).toHaveCount(1);
    expect(await beforeInput(input, "historyUndo")).toBe(false);
    await text(input, "left〔图1〕 right");
    await select(input, 14);
    expect(await beforeInput(input, "insertLineBreak")).toBe(false);
    await text(input, "left〔图1〕 right\n"); expect(posted).toBeUndefined();
    expect(await beforeInput(input, "insertParagraph")).toBe(false);
    await expect(page.getByText("mobile fixture", { exact: true })).toBeVisible();
    expect(posted).toMatchObject({ stagedAttachments: [{ ordinal: 1 }] });
    await text(input, "");
    expect(await beforeInput(input, "historyUndo")).toBe(false); await text(input, "");
  });
});

test("persona switch starts a separate draft and undo cannot recover another owner's prose", async ({ page }) => {
  await open(page); const input = editor(page);
  await input.fill("private first persona draft"); await input.pressSequentially("!");
  const original = await input.elementHandle();
  // Next integrates the native history API with useSearchParams. This changes
  // the real ChatPage source/persona session key without a document reload.
  await page.evaluate(() => history.pushState(null, "", "/en/app?persona=editor-fixture-other"));
  await expect(input).toBeVisible(); await text(input, "");
  expect(await input.evaluate((element, old) => element === old, original)).toBe(false);
  await input.focus(); await input.press("Control+z"); await text(input, "");
  await input.fill("second persona draft");
  await page.evaluate(() => history.pushState(null, "", "/en/app"));
  await text(input, ""); await input.focus(); await input.press("Control+z"); await text(input, "");
});
