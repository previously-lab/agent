import { createHash } from "node:crypto";
import { collapseConversation } from "./manuscript-navigation";
import type { Page } from "@playwright/test";
import type { DialogueArtifactRef, DialogueEvent, DialogueInput, DialoguePage, PublicUtterance } from "@/lib/chat/dialogue-contract";
import { test, expect } from "./test";
import { clearEpisodic } from "./memory-fixture";

const at = "2026-11-06T09:00:00.000Z";
const editor = (page: Page) => page.locator("[data-manuscript-input]");
const primary = (page: Page) => page.locator("[data-conversation-primary]");
const publication = (page: Page, id: string) => page.locator(`[data-public-utterance="${id}"]`);

async function fixture(page: Page) {
  const events: DialogueEvent[] = [];
  const posts: { dialogueVersion: number; messages: { id: string; parts: { type: string; text?: string }[] }[] }[] = [];
  const stops: { persona: string; workId?: string }[] = [];
  const state: { offline: boolean; expression: DialoguePage["expression"]; rejectNext: boolean } = { offline: false, expression: "idle", rejectNext: false };
  const accept = (id: string, text: string, clientMessageId = id): DialogueInput => {
    const eventSeq = events.length + 1;
    const input: DialogueInput = { inputId: id, clientMessageId, userSeq: eventSeq, eventSeq, text, acceptedAt: at };
    events.push({ type: "input.accepted", eventSeq, input });
    return input;
  };
  const publish = (utteranceId: string, inputIds: string[], blocks: PublicUtterance["blocks"]) => {
    const utterance: PublicUtterance = { utteranceId, inputIds, blocks, committedAt: at, sourceResults: [],
      publicSeq: events.filter(event => event.type === "manuscript.append").length + 1 };
    events.push({ type: "manuscript.append", eventSeq: events.length + 1, utterance });
    return utterance;
  };
  await page.route("**/api/chat/dialogue?*", route => {
    if (state.offline) return route.fulfill({ status: 503, json: { code: "dialogue_unavailable" } });
    const after = Number(new URL(route.request().url()).searchParams.get("after"));
    const json: DialoguePage = { version: 1, events: events.filter(event => event.eventSeq > after), cursor: events.length, hasMore: false, expression: state.expression };
    return route.fulfill({ json });
  });
  await page.route("**/api/chat", route => {
    const body = route.request().postDataJSON() as (typeof posts)[number];
    posts.push(body);
    if (state.rejectNext) { state.rejectNext = false; return route.fulfill({ status: 503, json: { code: "dialogue_unavailable" } }); }
    const message = body.messages.at(-1)!;
    const workId = `work-${posts.length}`;
    const input = accept(`input-${posts.length}`, message.parts.map(part => part.text ?? "").join(""), message.id);
    events.push({ type: "work.status", eventSeq: events.length + 1, work: { workId, inputId: input.inputId, userSeq: input.userSeq, status: "running" } });
    return route.fulfill({ status: 202, json: { version: 1, input, workId } });
  });
  await page.route("**/api/chat/dialogue/stop", route => {
    const body = route.request().postDataJSON() as (typeof stops)[number];
    stops.push(body);
    if (!body.workId) state.expression = "paused";
    return route.fulfill({ json: { stopped: true } });
  });
  return { events, accept, publish, posts, state, stops };
}

test.beforeEach(async () => { await clearEpisodic(); });

test.describe("narrow phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("pill composition, IME and consecutive sends keep one draft owner", async ({ page }) => {
    const mock = await fixture(page);
    await page.goto("/en/app");
    const input = editor(page);
    await expect(input).toBeEditable();
    await input.fill("First accepted question");
    await input.press("Enter");
    await expect.poll(() => mock.posts.length).toBe(1);
    await input.fill("Draft across the mobile pill");
    const original = await input.elementHandle();
    await collapseConversation(page);
    await expect(page.locator("[data-pill-composer]")).toBeVisible();
    expect(await input.count()).toBe(1);
    expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
    await input.dispatchEvent("compositionstart", { data: "Draft" });
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, which: 229,
      isComposing: true, bubbles: true, cancelable: true });
    await expect(input).toHaveAttribute("data-editor-text", "Draft across the mobile pill");
    await input.dispatchEvent("compositionend", { data: "Draft" });
    await input.press("Enter");
    await expect.poll(() => mock.posts.length).toBe(2);
    await input.fill("A third question while earlier work is active");
    await input.press("Enter");
    await expect.poll(() => mock.posts.length).toBe(3);
    expect(mock.posts.map(post => post.messages[0].parts.map(part => part.text ?? "").join(""))).toEqual([
      "First accepted question", "Draft across the mobile pill", "A third question while earlier work is active",
    ]);
    await collapseConversation(page);
    await expect(page.locator("[data-pill-expand]")).toBeVisible();
    await input.fill("Unsent follow-up");
    await page.locator("[data-pill-expand]").click();
    await expect(page.locator(".conversation-panel")).toHaveAttribute("data-panel-tier", "fullscreen");
    expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
    await expect(input).toHaveAttribute("data-editor-text", "Unsent follow-up");
  });

  test("acceptance remains usable during recovery failure; reverse replies and stop preserve the single editor", async ({ page }) => {
    const mock = await fixture(page);
    mock.state.offline = true;
    await page.goto("/zh/app");
    await expect(editor(page)).toBeEditable();
    const original = await editor(page).elementHandle();
    await editor(page).fill("请查苹果。");
    await editor(page).press("Enter");
    await expect(page.locator('[data-dialogue-input="input-1"]')).toContainText("请查苹果。");
    await expect(primary(page)).toHaveAttribute("data-primary-action", "stop");
    await editor(page).fill("再查音响。");
    mock.state.rejectNext = true;
    await editor(page).press("Enter");
    await expect.poll(() => mock.posts.length).toBe(2);
    await expect(editor(page)).toHaveAttribute("data-editor-text", "再查音响。");
    await expect(page.locator('[data-dialogue-input="input-2"]')).toHaveCount(0);
    await expect(page.locator("[data-composer-secondary-send]")).toBeEnabled();
    await editor(page).press("Enter");
    await expect.poll(() => mock.posts.length).toBe(3);
    expect(mock.posts.every(post => post.dialogueVersion === 1)).toBe(true);
    expect(mock.posts[2].messages[0].id).toBe(mock.posts[1].messages[0].id);
    await expect(editor(page)).toHaveAttribute("data-editor-text", "");
    mock.state.offline = false;
    mock.publish("sound-first", ["input-3"], [{ kind: "markdown", blockId: "a", text: "音响资料先找到了。" }]);
    await expect(publication(page, "sound-first")).toBeVisible();
    const first = await publication(page, "sound-first").elementHandle();
    mock.publish("fruit-later", ["input-1"], [{ kind: "markdown", blockId: "a", text: "苹果的资料也找到了。" }]);
    await expect(publication(page, "fruit-later")).toContainText("回应：请查苹果。");
    expect(await page.locator("[data-public-utterance]").evaluateAll(rows => rows.map(row => row.getAttribute("data-public-utterance")))).toEqual(["sound-first", "fruit-later"]);
    expect(await publication(page, "sound-first").evaluate((row, before) => row === before, first)).toBe(true);
    expect(await editor(page).evaluate((node, before) => node === before, original)).toBe(true);
    await primary(page).click();
    await expect.poll(() => mock.stops).toEqual([{ persona: "user" }]);
    await expect(primary(page)).toHaveAttribute("data-primary-action", "send");
    await expect(publication(page, "sound-first")).toHaveCount(1);
    await expect(publication(page, "fruit-later")).toHaveCount(1);
  });
});

test("committed artifact slots keep footnotes and original HTML; loading or missing refs don't move the reading anchor", async ({ page }) => {
  const mock = await fixture(page);
  for (let i = 1; i <= 16; i++) mock.accept(`seed-${i}`, `Original question ${i}: a whole paragraph of context to read before the new reply.`);
  const body = "<!doctype html><button id='increment'>Count: 0</button><script>const b=document.querySelector('#increment');let n=previously.getState()?.count??0;b.textContent='Count: '+n;b.onclick=()=>{n++;previously.setState({count:n});b.textContent='Count: '+n};</script>";
  const artifact: DialogueArtifactRef = { artifactId: "original-widget", sourceOwnerId: "original-work", revision: 1,
    kind: "native_html", mediaType: "text/html", byteSize: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), height: 192 };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/chat/dialogue/artifacts/*?*", async route => {
    if (!route.request().url().includes("original-widget")) return route.fulfill({ status: 404, json: { error: "Missing" } });
    await held;
    await route.fulfill({ json: { artifact, body } });
  });
  await page.goto("/en/app"); await expect(editor(page)).toBeEditable();
  const scroller = page.locator("[data-conversation-field]");
  await expect(page.locator('[data-dialogue-input="seed-16"]')).toBeVisible();
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const anchor = page.locator('[data-dialogue-input="seed-1"]');
  await expect(anchor).toBeVisible();
  const before = (await anchor.boundingBox())!.y;
  const answer = mock.publish("artifact-answer", ["seed-16"], [
    { kind: "markdown", blockId: "lead", text: "The complete answer[^source]." },
    { kind: "artifact_ref", blockId: "figure", artifact },
    { kind: "artifact_ref", blockId: "missing", artifact: { ...artifact, artifactId: "missing-widget" } },
    { kind: "markdown", blockId: "tail", text: "This text still works.\n\n[^source]: The original evidence." },
  ]);
  await expect(page.locator("[data-dialogue-new-replies]")).toBeVisible();
  expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  await page.locator("[data-dialogue-new-replies]").click();
  const reply = publication(page, "artifact-answer");
  await expect(reply.locator('[data-artifact-ref="original-widget"]')).toHaveAttribute("data-artifact-state", "pending");
  await expect(reply.locator('[data-artifact-ref="missing-widget"]')).toHaveAttribute("data-artifact-state", "unavailable");
  await expect(reply.getByText("This text still works.")).toBeVisible();
  await expect(reply.locator("[data-footnote-ref]")).toHaveCount(1);
  release();
  const widget = reply.locator('[data-native-frame]').contentFrame().frameLocator('[data-native-content]');
  await widget.getByRole("button", { name: "Count: 0" }).click();
  await expect(widget.getByRole("button", { name: "Count: 1" })).toBeVisible();
  mock.events.push({ type: "manuscript.append", eventSeq: mock.events.length + 1, utterance: answer });
  await expect.poll(() => page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("previously:native-replies:v1") ?? '{"entries":[]}') as { entries: { json: string }[] };
    return store.entries.some(({ json }) => {
      const state = JSON.parse(json) as { custom?: { count?: number } };
      return state.custom?.count === 1;
    });
  })).toBe(true);
  await page.reload();
  await expect(publication(page, "artifact-answer")).toHaveCount(1);
  await expect(widget.getByRole("button", { name: "Count: 1" })).toBeVisible();
});
