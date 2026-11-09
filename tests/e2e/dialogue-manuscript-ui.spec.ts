import { createHash } from "node:crypto";
import { collapseConversation } from "./manuscript-navigation";
import type { Page } from "@playwright/test";
import type { DialogueArtifactRef, DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import { test, expect } from "./test";
import { clearEpisodic } from "./memory-fixture";

const at = "2026-11-06T09:00:00.000Z";
const editor = (page: Page) => page.locator("[data-manuscript-input]");
const primary = (page: Page) => page.locator("[data-conversation-primary]");
const publication = (page: Page, id: string) => page.locator(`[data-public-utterance="${id}"]`);

async function fixture(page: Page) {
  type Work = { input: DialogueInput; parentRunId: string; reply?: PublicUtterance; gate: Promise<void>; release: () => void };
  const works: Work[] = [];
  const posts: { dialogueVersion: number; regenerate?: boolean; dialogueInputId?: string;
    messages: { id: string; role: string; parts: { type: string; text?: string }[] }[] }[] = [];
  const stops: string[] = [];
  const state = { rejectNext: false };
  await page.route("**/api/chat/dialogue?*", route => route.fulfill({ json: { version: 2, enabled: true } }));
  await page.route("**/api/chat/*/offers", async route => {
    const runId = new URL(route.request().url()).pathname.split("/")[3];
    const work = works.find(candidate => candidate.parentRunId === runId);
    if (!work) return route.fulfill({ status: 404, json: { error: "Unknown work" } });
    await work.gate;
    return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "done", status: "completed" })}\n\n` });
  });
  await page.route("**/api/chat", async route => {
    const body = route.request().postDataJSON() as (typeof posts)[number];
    posts.push(body);
    if (state.rejectNext) { state.rejectNext = false; return route.fulfill({ status: 503, json: { code: "dialogue_unavailable" } }); }
    const original = body.regenerate ? works.find(work => work.input.inputId === body.dialogueInputId) : undefined;
    const message = body.messages.at(-1)!;
    const ordinal = posts.length;
    const input: DialogueInput = original?.input ?? {
      inputId: `input-${ordinal}`, clientMessageId: message.id, userSeq: ordinal, eventSeq: ordinal,
      text: message.parts.map(part => part.text ?? "").join(""), acceptedAt: at,
    };
    const parentRunId = `thought-${ordinal}`;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const work: Work = { input, parentRunId, gate, release };
    works.push(work);
    return route.fulfill({ json: {
      version: 2, parentRunId, runId: parentRunId, sourceInputId: input.inputId, workId: parentRunId, input,
      offersUrl: `/api/chat/${parentRunId}/offers`, thoughtsUrl: `/api/chat/${parentRunId}/thoughts?workId=${parentRunId}`,
    } });
  });
  const publicStream = (work: Work) => {
    const utterance = work.reply!;
    const text = utterance.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n");
    const events: Record<string, unknown>[] = [
      { type: "start", messageId: utterance.utteranceId },
      { type: "text-start", id: "public-text" },
      { type: "text-delta", id: "public-text", delta: text },
      { type: "data-dialogue-publication", data: utterance },
    ];
    for (const block of utterance.blocks) {
      if (block.kind === "artifact_ref" && block.artifact.artifactId === "original-widget") {
        events.push({ type: "data-dialogue-artifact", data: { blockId: block.blockId, artifact: block.artifact,
          body: "<!doctype html><button id='increment'>Count: 0</button><script>const b=document.querySelector('#increment');let n=previously.getState()?.count??0;b.textContent='Count: '+n;b.onclick=()=>{n++;previously.setState({count:n});b.textContent='Count: '+n};</script>" } });
      }
    }
    events.push({ type: "text-end", id: "public-text" }, { type: "finish" });
    return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  };
  await page.route("**/api/chat/dialogue/reply", route => {
    const body = route.request().postDataJSON() as { thoughtRunId: string };
    const work = works.find(candidate => candidate.parentRunId === body.thoughtRunId);
    if (!work?.reply) return route.fulfill({ status: 409, json: { error: "Not ready" } });
    return route.fulfill({ contentType: "text/event-stream", headers: { "x-workflow-run-id": `dialogue-${work.parentRunId}` }, body: publicStream(work) });
  });
  await page.route(/\/api\/chat\/[^/]+\/stream(?:\?.*)?$/, route => {
    const runId = new URL(route.request().url()).pathname.split("/")[3];
    const work = works.find(candidate => `dialogue-${candidate.parentRunId}` === runId);
    if (!work?.reply) return route.fulfill({ status: 404, json: { error: "Unknown public run" } });
    return route.fulfill({ contentType: "text/event-stream", body: publicStream(work) });
  });
  await page.route("**/api/chat/*/cancel", route => {
    stops.push(new URL(route.request().url()).pathname.split("/")[3]!);
    return route.fulfill({ json: { ok: true } });
  });
  const publish = (utteranceId: string, inputIds: string[], blocks: PublicUtterance["blocks"]) => {
    const work = works.find(candidate => candidate.input.inputId === inputIds[0]);
    if (!work) throw new Error(`Unknown work for ${inputIds[0]}`);
    work.reply = { utteranceId, inputIds, blocks, committedAt: at, sourceResults: [], publicSeq: works.filter(candidate => candidate.reply).length };
    work.release();
    return work.reply;
  };
  return { works, publish, posts, state, stops };
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
    expect(mock.posts.map(post => post.messages.findLast(message => message.role === "user")!.parts.map(part => part.text ?? "").join(""))).toEqual([
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
    await page.goto("/zh/app");
    await expect(editor(page)).toBeEditable();
    const original = await editor(page).elementHandle();
    await editor(page).fill("请查苹果。");
    await editor(page).press("Enter");
    await expect(page.locator("[data-dialogue-input]").filter({ hasText: "请查苹果。" })).toBeVisible();
    await expect(primary(page)).toHaveAttribute("data-primary-action", "stop");
    await editor(page).fill("再查音响。");
    mock.state.rejectNext = true;
    await editor(page).press("Enter");
    await expect.poll(() => mock.posts.length).toBe(2);
    await expect(editor(page)).toHaveAttribute("data-editor-text", "再查音响。");
    await expect(page.locator("[data-dialogue-input]").filter({ hasText: "再查音响。" })).toHaveCount(0);
    await expect(page.locator("[data-composer-secondary-send]")).toBeEnabled();
    await editor(page).press("Enter");
    await expect.poll(() => mock.posts.length).toBe(3);
    expect(mock.posts.every(post => post.dialogueVersion === 2)).toBe(true);
    expect(mock.posts[2].messages.findLast(message => message.role === "user")!.id)
      .toBe(mock.posts[1].messages.findLast(message => message.role === "user")!.id);
    await expect(editor(page)).toHaveAttribute("data-editor-text", "");
    mock.publish("sound-first", ["input-3"], [{ kind: "markdown", blockId: "a", text: "音响资料先找到了。" }]);
    await expect(publication(page, "sound-first")).toBeVisible();
    const first = await publication(page, "sound-first").elementHandle();
    mock.publish("fruit-later", ["input-1"], [{ kind: "markdown", blockId: "a", text: "苹果的资料也找到了。" }]);
    await expect(publication(page, "fruit-later")).toContainText("苹果的资料也找到了。");
    expect(await page.locator("[data-public-utterance]").evaluateAll(rows => rows.map(row => row.getAttribute("data-public-utterance")))).toEqual(["fruit-later", "sound-first"]);
    expect(await publication(page, "sound-first").evaluate((row, before) => row === before, first)).toBe(true);
    expect(await editor(page).evaluate((node, before) => node === before, original)).toBe(true);
    await editor(page).fill("仍在进行的工作");
    await editor(page).press("Enter");
    await expect.poll(() => mock.posts.length).toBe(4);
    await expect(primary(page)).toHaveAttribute("data-primary-action", "stop");
    await primary(page).click();
    await expect.poll(() => mock.stops.length).toBeGreaterThan(0);
    await expect(primary(page)).toHaveAttribute("data-primary-action", "send");
    await expect(publication(page, "sound-first")).toHaveCount(1);
    await expect(publication(page, "fruit-later")).toHaveCount(1);
  });
});

test("committed artifact slots keep footnotes and original HTML; loading or missing refs don't move the reading anchor", async ({ page }) => {
  const mock = await fixture(page);
  await page.goto("/en/app");
  await expect(editor(page)).toBeEditable();
  for (let i = 1; i <= 16; i++) {
    await editor(page).fill(`Original question ${i}: a whole paragraph of context to read before the new reply.`);
    await editor(page).press("Enter");
    await expect.poll(() => mock.posts.length).toBe(i);
  }
  const body = "<!doctype html><button id='increment'>Count: 0</button><script>const b=document.querySelector('#increment');let n=previously.getState()?.count??0;b.textContent='Count: '+n;b.onclick=()=>{n++;previously.setState({count:n});b.textContent='Count: '+n};</script>";
  const artifact: DialogueArtifactRef = { artifactId: "original-widget", sourceOwnerId: "original-work", revision: 1,
    kind: "native_html", mediaType: "text/html", byteSize: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), height: 192 };
  const scroller = page.locator("[data-conversation-field]");
  await expect(page.locator("[data-dialogue-input]").filter({ hasText: "Original question 16:" })).toBeVisible();
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const anchor = page.locator("[data-dialogue-input]").filter({ hasText: "Original question 1:" });
  await expect(anchor).toBeVisible();
  const before = (await anchor.boundingBox())!.y;
  mock.publish("artifact-answer", ["input-16"], [
    { kind: "markdown", blockId: "lead", text: "The complete answer[^source]." },
    { kind: "artifact_ref", blockId: "figure", artifact },
    { kind: "artifact_ref", blockId: "missing", artifact: { ...artifact, artifactId: "missing-widget" } },
    { kind: "markdown", blockId: "tail", text: "This text still works.\n\n[^source]: The original evidence." },
  ]);
  await expect(page.locator("[data-dialogue-new-replies]")).toBeVisible();
  expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  await page.locator("[data-dialogue-new-replies]").click();
  const reply = publication(page, "artifact-answer");
  await expect(reply.locator('[data-artifact-ref="original-widget"]')).toHaveAttribute("data-artifact-state", "ready");
  await expect(reply.locator('[data-artifact-ref="missing-widget"]')).toHaveAttribute("data-artifact-state", "unavailable");
  await expect(reply.getByText("This text still works.")).toBeVisible();
  await expect(reply.locator("[data-footnote-ref]")).toHaveCount(1);
  const widget = reply.locator('[data-native-frame]').contentFrame().frameLocator('[data-native-content]');
  await widget.getByRole("button", { name: "Count: 0" }).click();
  await expect(widget.getByRole("button", { name: "Count: 1" })).toBeVisible();
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
