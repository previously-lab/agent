import type { ElementHandle, Locator, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { test, expect } from "./test";
import { E2E_MEMORY_ROOT, E2E_SESSIONS_ROOT } from "./env";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
} from "./memory-fixture";


function composerInput(page: Page) {
  return page.locator("[data-manuscript-input]");
}

async function openConversation(page: Page) {
  const expand = page.getByRole("button", { name: "Expand to full screen" });
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  const textarea = composerInput(page);
  await expect(expand.or(retry).or(textarea).first()).toBeVisible({ timeout: 30_000 });
  if (await retry.isVisible()) await retry.click();
  await expect(expand.or(textarea).first()).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  await expect(textarea).toBeVisible();
  await expect(page.locator(".conversation-panel")).toHaveAttribute("data-panel-tier", "fullscreen");
}

function offlineSse(answer: string): string {
  const chunks = [
    { type: "start", messageId: "manuscript-fixture-reply" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: answer },
    { type: "text-end", id: "text" },
    { type: "finish" },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}

`).join("")}data: [DONE]

`;
}

async function selectReference(page: Page, title: string): Promise<void> {
  if (!(await page.locator("[data-document-mention]").isVisible())) {
    await page.locator("[data-composer-tools-trigger]").click();
  }
  await page.locator("[data-document-mention]:visible").click();
  const search = page.getByRole("combobox", { name: "Search documents" });
  await expect(search).toBeVisible();
  await search.fill(title);
  const option = page.getByRole("option").filter({ hasText: title });
  await expect(option).toHaveCount(1, { timeout: 30_000 });
  await option.click();
  await page.getByRole("button", { name: "Close document picker" }).click();
  await expect(page.locator(".document-reference-chip").filter({ hasText: title })).toHaveCount(1);
}

async function attachFixture(page: Page): Promise<string> {
  // These requests deliberately use the real isolated local attachment
  // routes. Only model endpoints are mocked by the shared test fixture.
  const uploading = page.waitForResponse(response => new URL(response.url()).pathname === "/api/attachments/upload" && response.request().method() === "POST");
  const reading = page.waitForResponse(response => new URL(response.url()).pathname === "/api/attachments" && response.request().method() === "GET");
  await page.locator("input[type=file]").first().setInputFiles({
    name: "fixture-note.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64"),
  });
  const uploaded = await uploading;
  expect(uploaded.status()).toBe(201);
  expect(uploaded.request().headers()["content-type"]).toContain("multipart/form-data; boundary=");
  const form = uploaded.request().postDataBuffer()!.toString("latin1");
  expect(form).toContain('name="file"; filename="fixture-note.png"');
  expect(form).toContain('name="persona"\r\n\r\nuser');
  const { attachment } = await uploaded.json();
  expect(attachment).toMatchObject({ version: 1, name: "fixture-note.png", mediaType: "image/png" });
  expect(attachment.assetId).toMatch(/^img_[a-f0-9]{32}$/);
  expect(attachment.ref).toBe(`drafts/${attachment.assetId}`);
  // Exercise the real server's path resolution: a successful HTTP upload must
  // have landed in the fixture root, never the repo's default sessions/.
  const scopeKey = createHash("sha256").update(JSON.stringify({ source: "local", origin: [E2E_MEMORY_ROOT, E2E_SESSIONS_ROOT], persona: "user" })).digest("hex");
  const manifest = JSON.parse(await readFile(path.join(E2E_SESSIONS_ROOT, "attachment-drafts", scopeKey, `${attachment.assetId}.json`), "utf8"));
  expect(manifest.scope).toEqual({ source: "local", key: scopeKey, persona: "user" });
  expect(manifest.snapshot.assetId).toBe(attachment.assetId);
  const read = await reading;
  expect(read.status()).toBe(200);
  expect(read.headers()["content-type"]).toBe("image/png");
  expect(new URL(read.url()).searchParams.get("ref")).toBe(attachment.ref);
  expect(new URL(read.url()).searchParams.get("persona")).toBe("user");
  expect((await read.body()).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  await expect(page.getByRole("button", { name: "Remove attachment: fixture-note.png" })).toBeVisible();
  await expect.poll(() => page.locator('[data-attachment-preview] img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  return attachment.assetId;
}

async function expectSameNode(
  page: Page,
  original: ElementHandle | null,
): Promise<void> {
  expect(original).not.toBeNull();
  expect(await composerInput(page).evaluate((current, before) => current === before, original)).toBe(true);
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

    test.afterEach(async () => {
      await clearCases();
      await clearEpisodic();
    });

    test("mini controls keep the manuscript visible and retain the live editor, attachment and @ reference", async ({ page }, testInfo) => {
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
      await seedCases([{ category: "research", name: "manuscript-context", opened: "2026-02-01", pieces: [] }]);
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

      const input = composerInput(page);
      await expect(page.locator("[data-composer-tail] [data-manuscript-input]")).toHaveCount(1);
      expect(await input.evaluate((el, lastTurn) => Boolean(lastTurn!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING), await agent.elementHandle())).toBe(true);
      const originalNode = await input.elementHandle();
      const draft = "This draft stays with me when I return to the room.";
      await input.fill(draft);
      await selectReference(page, "manuscript-context");
      const assetId = await attachFixture(page);
      await input.dispatchEvent("compositionstart", { data: "draft" });

      await page.getByRole("button", { name: "Exit full screen" }).click();
      await expect(page.locator("[data-pill-composer]")).toBeVisible();
      await expect(page.locator("[data-conversation-field]")).toBeVisible();
      await expect(agent).toBeVisible();
      await expect(input).toHaveAttribute("data-editor-text", `${draft}〔图1〕`);
      await expectSameNode(page, originalNode);
      await expect(page.getByRole("button", { name: "Remove attachment: fixture-note.png" })).toBeVisible();
      await expect(page.locator(".document-reference-chip").filter({ hasText: "manuscript-context" })).toHaveCount(1);
      expect(await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      const pill = await page.locator("[data-pill-composer]").boundingBox();
      expect(pill!.x).toBeGreaterThanOrEqual(0);
      expect(pill!.x + pill!.width).toBeLessThanOrEqual(viewport.width);

      await page.getByRole("button", { name: "Expand to full screen" }).click();
      await expect(input).toHaveAttribute("data-editor-text", `${draft}〔图1〕`);
      await expectSameNode(page, originalNode);
      await expect(page.getByRole("button", { name: "Remove attachment: fixture-note.png" })).toBeVisible();
      await expect(page.locator(".document-reference-chip").filter({ hasText: "manuscript-context" })).toHaveCount(1);
      await input.dispatchEvent("compositionend", { data: draft });
      const remove = page.getByRole("button", { name: "Remove attachment: fixture-note.png" });
      const cancellation = page.waitForResponse(response => new URL(response.url()).pathname === `/api/attachments/upload/${assetId}/cancel` && response.request().method() === "POST");
      await remove.click();
      const cancelled = await cancellation;
      expect(cancelled.status()).toBe(204);
      expect(new URL(cancelled.url()).searchParams.get("persona")).toBe("user");
      console.log(`Real local PNG upload/GET/cancel PASS (${viewport.name}; persona=user; stable draft ref)`);
      await expect(remove).toHaveCount(0);
      await expect(input).toHaveAttribute("data-editor-text", `${draft}〔图1〕`);
      const screenshot = await page.screenshot({ path: testInfo.outputPath("manuscript.png") });
      await testInfo.attach("manuscript", { body: screenshot, contentType: "image/png" });
    });
  });
}

test.describe("manuscript editing integration", () => {
  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
  });

  test("empty conversation sends the exact draft through mocked SSE without remounting the editor", async ({ page }, testInfo) => {
    const posts: { messages?: { role?: string; parts?: { type: string; text?: string }[] }[] }[] = [];
    const answer = "The first reply arrives directly after the unchanged paragraph.";
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts.push(route.request().postDataJSON());
      await route.fulfill({ contentType: "text/event-stream", body: offlineSse(answer) });
    });
    await clearEpisodic();
    await page.goto("/en/app");
    const input = composerInput(page);
    await expect(input).toBeVisible({ timeout: 30_000 });
    const originalNode = await input.elementHandle();
    const draft = "The first paragraph stays exactly as written.\n\nIts second paragraph remains part of the same user turn.";
    await input.fill(draft);
    await input.press("Enter");

    const user = page.locator("[data-conversation-turn][data-role=user]").filter({ hasText: "The first paragraph stays exactly as written." });
    const agent = page.locator("[data-conversation-turn]").filter({ hasText: answer });
    await expect(user).toBeVisible();
    await expect(agent).toBeVisible({ timeout: 30_000 });
    await expectSameNode(page, originalNode);
    await expect(input).toHaveAttribute("data-editor-text", "");
    await expect(input).toBeEditable();
    await expect(page.locator("[data-manuscript-composer]")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("[data-composer-send]")).toBeDisabled();
    expect(posts).toHaveLength(1);
    const posted = posts[0]!.messages?.at(-1);
    expect(posted?.role).toBe("user");
    expect(posted?.parts?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("")).toBe(draft);
    expect(await user.evaluate((el) => el.textContent)).toContain("Its second paragraph remains part of the same user turn.");
    expect(await agent.evaluate((el, userEl) => Boolean(userEl!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING), await user.elementHandle())).toBe(true);
    await testInfo.attach("sent-manuscript", {
      body: await page.screenshot({ path: testInfo.outputPath("sent-manuscript.png"), style: "nextjs-portal { visibility: hidden !important; }" }),
      contentType: "image/png",
    });
  });

  test("a long draft grows the manuscript instead of becoming an internal scrollbox", async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "LONG-DRAFT" })]);
    await page.goto("/en/app");
    await openConversation(page);
    const input = composerInput(page);
    const field = page.locator("[data-conversation-field]");
    await expect(field).toBeVisible();
    await expect(page.locator("[data-conversation-turn]").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const before = await field.evaluate((el) => el.scrollHeight);
    const draft = Array.from(
      { length: 12 },
      (_, index) => `Draft paragraph ${index + 1}: this sentence stays in the flowing manuscript while the editor grows.`,
    ).join("\n\n");
    await input.fill(draft);

    await expect.poll(() => input.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(160);
    await expect.poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    expect(await field.evaluate((el) => el.scrollHeight)).toBeGreaterThan(before);
    const toolbar = page.locator("[data-conversation-controls]");
    await expect(toolbar).toBeVisible();
    await expect(page.locator("[data-manuscript-input]")).toHaveCount(1);
    await testInfo.attach("long-draft", {
      body: await page.screenshot({ path: testInfo.outputPath("long-draft.png"), style: "nextjs-portal { visibility: hidden !important; }" }),
      contentType: "image/png",
    });

    // The new viewport control seat remains reachable while prose grows.
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveCSS("position", "fixed");
    await page.locator("[data-composer-tools-trigger]").click();
    await expect(page.locator("[data-attach]:visible")).toBeVisible();
    await expect(page.locator("[data-document-mention]:visible")).toBeVisible();
    await expect(page.locator("[data-composer-send]:visible")).toBeVisible();
    const box = await toolbar.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
    await expect(page.locator("[data-manuscript-input]")).toHaveCount(1);
  });

  test("IME Enter stays uncancelled, Shift+Enter adds lines, and Enter sends", async ({ page }) => {
    const posts: unknown[] = [];
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts.push(route.request().postDataJSON());
      await route.fulfill({ contentType: "text/event-stream", body: offlineSse("Reply after composition") });
    });
    await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "IME" })]);
    await page.goto("/en/app");
    await openConversation(page);
    const input = composerInput(page);
    const originalNode = await input.elementHandle();
    await input.fill("拼音草稿");
    const imeEnterAllowed = await input.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { data: "pinyin", bubbles: true }));
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "keyCode", { value: 229 });
      Object.defineProperty(event, "which", { value: 229 });
      return el.dispatchEvent(event);
    });
    expect(imeEnterAllowed).toBe(true);
    expect(posts).toHaveLength(0);
    await expect(input).toHaveAttribute("data-editor-text", "拼音草稿");
    await expectSameNode(page, originalNode);
    await input.dispatchEvent("compositionend", { data: "拼音草稿" });

    await input.press("Shift+Enter");
    await input.pressSequentially("换行");
    await expect(input).toHaveAttribute("data-editor-text", "拼音草稿\n换行");
    expect(posts).toHaveLength(0);
    await input.press("Shift+Enter");
    await expect(input).toHaveAttribute("data-editor-text", "拼音草稿\n换行\n");
    expect(posts).toHaveLength(0);
    await input.press("Enter");
    await expect(page.getByText("Reply after composition", { exact: true })).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  test("archived records keep the live manuscript prose and typography", async ({ page }, testInfo) => {
    const at = "2026-02-01T09:00:00.000Z";
    const slice = makeSlice(at, { tag: "ARCHIVE-PARITY" });
    slice.turns[1].content = "The room keeps the first paragraph intact.\n\nThe archived record carries the same second paragraph.";
    await seedSlices([slice]);
    await page.goto("/en/app");
    await openConversation(page);
    const live = page.locator("[data-conversation-turn][data-role=agent] .conversation-prose").filter({ hasText: "The room keeps the first paragraph intact." });
    await expect(live).toBeVisible();
    const liveText = await live.textContent();
    const liveStyle = await live.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    const input = composerInput(page);
    await expect(input).toHaveCSS("font-size", liveStyle.fontSize);
    const originalInput = await input.elementHandle();
    // Exercise the shared token and the rem basis separately. A hard-coded
    // 1rem passes root-only scaling but must fail the token-only change.
    const expectResponsiveType = async (targets: Locator[]) => {
      const rootSize = await page.evaluate(() => {
        document.documentElement.style.setProperty("--text-base", "1.125rem");
        return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      });
      for (const target of targets) await expect(target).toHaveCSS("font-size", `${rootSize * 1.125}px`);
      await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
      for (const target of targets) await expect(target).toHaveCSS("font-size", "22.5px");
      await page.evaluate(() => {
        document.documentElement.style.removeProperty("--text-base");
        document.documentElement.style.removeProperty("font-size");
      });
      for (const target of targets) await expect(target).toHaveCSS("font-size", liveStyle.fontSize);
    };
    await expectResponsiveType([live, live.locator("p").first(), input]);
    await expectSameNode(page, originalInput);

    await page.goto(`/en/app?doc=records/${slice.id}`);
    const archived = page.locator(".document-record-turn .conversation-prose").filter({ hasText: "The room keeps the first paragraph intact." });
    await expect(archived).toBeVisible({ timeout: 30_000 });
    await expect(archived).toHaveText(liveText ?? "");
    const archivedStyle = await archived.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    expect(archivedStyle).toEqual(liveStyle);
    await expectResponsiveType([archived, archived.locator("p").first(), composerInput(page)]);
    await testInfo.attach("archived-record", {
      body: await page.screenshot({ path: testInfo.outputPath("archived-record.png") }),
      contentType: "image/png",
    });
  });
});
