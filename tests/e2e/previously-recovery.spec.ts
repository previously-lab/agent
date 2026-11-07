import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Route } from "@playwright/test";
import { encodeDialogueRecordTurn } from "@/lib/episodic/dialogue-record";
import { test, expect } from "./test";
import { clearEpisodic, seedSlices } from "./memory-fixture";
import { E2E_MEMORY_ROOT } from "./env";

// This suite seeds only the isolated 3100 server. Never point it at a real home.
test.beforeAll(() => {
  if (process.env.E2E_EXTERNAL_BASE_URL) throw new Error("Recovery fixtures require the isolated Playwright server");
});
test.beforeEach(async () => { await clearEpisodic(); });

const at = "2020-01-02T03:04:00.000Z";
const editor = (page: Page) => page.locator("[data-manuscript-input]");
const primary = (page: Page) => page.locator("[data-conversation-primary]");
const eventStream = (events: Record<string, unknown>[]) =>
  events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
const finish = { type: "finish", finishReason: "stop" };
const offer = (n: number) => ({ type: "offer", offerId: `offer-${n}`, runId: `child-${n}`, sourceInputId: `input-${n}` });
const done = { type: "done", status: "completed" };
const childEvents = (n: number, text: string, status: "done" | "error" = "done") => [
  { type: "start", messageId: `publication-${n}` },
  { type: "text-start", id: `text-${n}` },
  { type: "text-delta", id: `text-${n}`, delta: text },
  { type: "text-end", id: `text-${n}` },
  { type: "data-turn-status", id: "turn-status", data: { status } },
  finish,
];
const respondStream = (route: Route, events: Record<string, unknown>[]) =>
  route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(events) });

/** Browser-side v2 fixture: every chat request is intercepted; no model runs. */
async function mockV2(page: Page, options: { reject?: boolean; parentFailures?: number; failFirst?: boolean; holdFirstParent?: Promise<void>; history?: Record<string, unknown>[] } = {}) {
  let posts = 0;
  let parentReads = 0;
  let childReads = 0;
  const postBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/chat**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/chat/dialogue" && request.method() === "GET") {
      return route.fulfill({ json: { version: 1, events: options.history ?? [], cursor: options.history?.length ?? 0, hasMore: false, expression: "idle" } });
    }
    if (url.pathname === "/api/chat" && request.method() === "POST") {
      posts++;
      postBodies.push(request.postDataJSON());
      if (options.reject) return route.fulfill({ status: 503, json: { code: "dialogue_unavailable" } });
      const n = posts;
      return route.fulfill({ status: 200, json: { version: 2, parentRunId: `parent-${n}`, sourceInputId: `input-${n}`,
        workId: `work-${n}`, offersUrl: `/api/chat/parent-${n}/offers`, thoughtsUrl: `/api/chat/parent-${n}/thoughts` } });
    }
    const parent = url.pathname.match(/^\/api\/chat\/parent-(\d+)\/offers$/);
    if (parent && request.method() === "GET") {
      const n = Number(parent[1]);
      parentReads++;
      if (parentReads <= (options.parentFailures ?? 0)) return route.fulfill({ status: 503, body: "offline" });
      if (n === 1 && options.holdFirstParent) await options.holdFirstParent;
      if (n === 1 && options.failFirst) return respondStream(route, [{ type: "done", status: "failed" }]);
      return respondStream(route, [offer(n), done]);
    }
    const child = url.pathname.match(/^\/api\/chat\/child-(\d+)\/stream$/);
    if (child && request.method() === "GET") {
      childReads++;
      return respondStream(route, childEvents(Number(child[1]), "A public fixture reply."));
    }
    return route.abort("blockedbyclient");
  });
  return { get posts() { return posts; }, get parentReads() { return parentReads; }, get childReads() { return childReads; }, postBodies };
}

async function open(page: Page) {
  await page.goto("/en/app");
  await expect(editor(page)).toBeEditable();
}
async function send(page: Page, text: string) {
  await editor(page).fill(text);
  await editor(page).press("Enter");
}

test("fresh browser restores v2 record history without a legacy dialogue-store event", async ({ page }) => {
  const earlier = "An older v1 public fixture reply.";
  await mockV2(page, { history: [
    { type: "input.accepted", eventSeq: 1, input: { inputId: "old-input", clientMessageId: "old-client", userSeq: 1,
      eventSeq: 1, text: "An older v1 question.", acceptedAt: "2019-01-01T00:00:00.000Z" } },
    { type: "manuscript.append", eventSeq: 2, utterance: { utteranceId: "old-publication", publicSeq: 1,
      inputIds: ["old-input"], blocks: [{ kind: "markdown", blockId: "old-text", text: earlier }],
      sourceResults: [], committedAt: "2019-01-01T00:00:01.000Z" } },
  ] });
  const user = "A fixture question saved in a record.";
  const reply = "A fixture public answer restored from a record.";
  await seedSlices([{ id: "2020-01-02-0304", start: at, turns: [
    { role: "user", content: user, at, turnId: "fixture-input", clientMessageId: "fixture-client" },
    { role: "agent", content: reply, at: "2020-01-02T03:04:01.000Z", turnId: "fixture-record" },
  ] }]);
  const file = path.join(E2E_MEMORY_ROOT, "records", "2020", "01", "02", "0304", "core.md");
  let record = await readFile(file, "utf8");
  const inputMeta = encodeDialogueRecordTurn({ kind: "user_input", inputId: "fixture-input", userSeq: 1 });
  const replyMeta = encodeDialogueRecordTurn({ kind: "public_utterance", publicationId: "fixture-publication", publicSeq: 1,
    inputIds: ["fixture-input"], sourceResults: [], blocks: [{ kind: "markdown", blockId: "text", text: reply }] });
  record = record.replace("[message fixture-client]", `[message fixture-client] [dialogue ${inputMeta}] [body-escaped v1]`)
    .replace("(agent)\n", `(agent) [dialogue ${replyMeta}] [body-escaped v1]\n`);
  await writeFile(file, record, "utf8");
  await open(page);
  // Search the rendered conversation, allowing the list to mount the live edge.
  await expect(page.getByText(user, { exact: true })).toBeVisible();
  const restored = page.locator('[data-public-utterance="fixture-publication"]');
  const old = page.locator('[data-public-utterance="old-publication"]');
  await expect(restored).toContainText(reply);
  await expect(old).toContainText(earlier);
  await expect.poll(async () => old.evaluate((node, selector) => {
    const later = document.querySelector(selector);
    return Boolean(later && (node.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING));
  }, '[data-public-utterance="fixture-publication"]')).toBe(true);
});

test("a rejected acceptance keeps the draft editable", async ({ page }) => {
  const mock = await mockV2(page, { reject: true });
  await open(page);
  await send(page, "A draft to preserve");
  await expect.poll(() => mock.posts).toBe(1);
  await expect(editor(page)).toHaveAttribute("data-editor-text", "A draft to preserve");
  await expect(editor(page)).toBeEditable();
  await expect(page.getByText("Could not send", { exact: true }).first()).toBeVisible();
});

test("a v2 completed turn finishes normally, with process folded while waiting", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const mock = await mockV2(page, { holdFirstParent: gate });
  try {
    await open(page);
    await send(page, "Question for the fixture");
    await expect.poll(() => mock.posts).toBe(1);
    const disclosure = page.locator(".dialogue-work-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".dialogue-work-details")).toHaveCount(0);
    release();
    await expect(page.getByText("A public fixture reply.", { exact: true })).toBeVisible();
    await expect(primary(page)).toHaveAttribute("data-primary-action", "send");
    await expect(page.getByText("Reply incomplete", { exact: true })).toHaveCount(0);
    expect(mock.posts).toBe(1);
    expect(mock.childReads).toBe(1);
    expect(mock.postBodies[0]).toMatchObject({ dialogueVersion: 2 });
  } finally { release(); }
});

test("a parent connection interruption recovers by GET without posting again", async ({ page }) => {
  const mock = await mockV2(page, { parentFailures: 1 });
  await open(page);
  await send(page, "Reconnect this fixture");
  await expect(page.getByText("A public fixture reply.", { exact: true })).toBeVisible();
  await expect(primary(page)).toHaveAttribute("data-primary-action", "send");
  expect(mock.parentReads).toBeGreaterThanOrEqual(2);
  expect(mock.posts).toBe(1);
  expect(mock.childReads).toBe(1);
});

test("a terminal failed parent is visible and can be retried", async ({ page }) => {
  const mock = await mockV2(page, { failFirst: true });
  await open(page);
  await send(page, "Retry this fixture");
  await expect(page.getByText("Reply incomplete", { exact: true }).first()).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => mock.posts).toBe(2);
  await expect(page.getByText("A public fixture reply.", { exact: true })).toBeVisible();
  await expect(primary(page)).toHaveAttribute("data-primary-action", "send");
});
