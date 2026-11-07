import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import { clearEpisodic } from "./memory-fixture";

async function fixture(page: Page, count: number, withInitialReplies: boolean) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const records = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const inputId = `input-${index}`;
    const parentRunId = `parent-${index}`;
    return {
      version: 2,
      parentRunId,
      sourceInputId: inputId,
      workId: `work-${index}`,
      offersUrl: `/fixture/offers/${parentRunId}`,
      thoughtsUrl: `/fixture/thoughts/${parentRunId}`,
      acceptedAt: at,
      userMessage: {
        id: inputId,
        role: "user",
        parts: [{ type: "text", text: `Question ${index}: ${"Enough text to make the stream scrollable. ".repeat(10)}` }],
      },
      offers: withInitialReplies ? [{
        offerId: `offer-${index}`,
        runId: `run-${index}`,
        sourceInputId: inputId,
        messageId: `message-${index}`,
        messageAt: at,
      }] : [],
      done: index < count,
    };
  });
  const initialTexts = Object.fromEntries(withInitialReplies
    ? records.map((_, index) => [`run-${index + 1}`, `Answer ${index + 1}: ${"A complete answer with enough height. ".repeat(10)}`])
    : []);
  await page.addInitScript(({ records, initialTexts }) => {
    localStorage.setItem("previously:dialogue:parents:v2:user", JSON.stringify(records));
    const encoder = new TextEncoder();
    const texts = new Map<string, string>(Object.entries(initialTexts));
    const parents = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const originalFetch = window.fetch;
    const publishTarget = window as unknown as {
      fixturePublish: (input: { parentRunId: string; offerId: string; runId: string; sourceInputId: string; text: string }) => void;
    };
    publishTarget.fixturePublish = ({ parentRunId, offerId, runId, sourceInputId, text }) => {
      texts.set(runId, text);
      const controller = parents.get(parentRunId);
      if (!controller) throw new Error(`Parent stream not ready: ${parentRunId}`);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "offer", offerId, runId, sourceInputId,
      })}\n\n`));
    };
    window.fetch = async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.origin);
      if (url.pathname === "/api/chat/dialogue" && url.searchParams.get("capabilities") === "1") {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.startsWith("/fixture/offers/")) {
        const parentRunId = url.pathname.split("/").at(-1)!;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { parents.set(parentRunId, controller); },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const child = url.pathname.match(/^\/api\/chat\/([^/]+)\/stream$/);
      if (child) {
        const runId = decodeURIComponent(child[1]);
        const text = texts.get(runId);
        if (text === undefined) return new Response(null, { status: 404 });
        const events = [
          { type: "start", messageId: `message-${runId}` },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          { type: "finish" },
        ];
        const body = [...events.map(event => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("");
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    };
  }, { records, initialTexts });
}

async function publish(page: Page, index: number, offerId: string, text: string) {
  await page.evaluate(({ parentRunId, offerId, runId, sourceInputId, text }) => {
    (window as unknown as {
      fixturePublish: (input: { parentRunId: string; offerId: string; runId: string; sourceInputId: string; text: string }) => void;
    }).fixturePublish({ parentRunId, offerId, runId, sourceInputId, text });
  }, { parentRunId: `parent-${index}`, offerId, runId: `run-${offerId}`, sourceInputId: `input-${index}`, text });
}

const scroller = (page: Page) => page.locator("[data-conversation-field]");
const atBottom = (page: Page) => scroller(page).evaluate(
  element => element.scrollHeight - element.clientHeight - element.scrollTop,
);

test.beforeEach(async () => {
  await clearEpisodic();
});

test("mounts every item, leaves an upward reader alone, and follows from the bottom", async ({ page }) => {
  await fixture(page, 18, false);
  await page.goto("/en/app");
  const lastWork = page.locator('[data-key="dialogue-work:work-18"]');
  await expect(lastWork).toBeVisible();
  await expect(page.locator("[data-key]")).toHaveCount(36);
  expect(await page.locator('[data-key="dialogue-input:input-1"]').evaluate(element => element.isConnected)).toBe(true);

  await scroller(page).hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => scroller(page).evaluate(element => element.scrollTop)).toBe(0);
  const first = page.locator('[data-key="dialogue-input:input-1"]');
  await expect(first).toBeVisible();
  const before = (await first.boundingBox())!.y;
  await publish(page, 18, "later", "A new answer arrives while the reader is above.");
  await expect(lastWork).toContainText("A new answer arrives");
  await expect(page.locator("[data-dialogue-new-replies]")).toBeVisible();
  expect(Math.abs((await first.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  await expect(page.locator("[data-key]")).toHaveCount(36);

  await page.locator("[data-dialogue-new-replies]").click();
  await expect.poll(() => atBottom(page)).toBeLessThanOrEqual(8);
  await publish(page, 18, "followed", "The next answer follows because the reader returned.");
  await expect(page.getByText("The next answer follows because the reader returned.")).toBeVisible();
  await expect.poll(() => atBottom(page)).toBeLessThanOrEqual(8);
});

test("caption mouse and keyboard disclosure release following; work-only replies still scroll on demand", async ({ page }) => {
  await fixture(page, 12, false);
  await page.goto("/en/app");
  const work = page.locator('[data-key="dialogue-work:work-12"]');
  const caption = work.locator("[data-dialogue-work-caption]");
  await expect(caption).toBeVisible();
  await expect.poll(() => atBottom(page)).toBeLessThanOrEqual(8);

  await caption.click();
  await expect(caption).toHaveAttribute("aria-expanded", "true");
  const afterMouseToggle = await scroller(page).evaluate(element => element.scrollTop);
  await publish(page, 12, "work-reply-1", "The first public reply is seated inside the work turn.");
  await expect(work).toContainText("The first public reply");
  await expect(page.locator("[data-dialogue-new-replies]")).toBeVisible();
  expect(await scroller(page).evaluate(element => element.scrollTop)).toBeCloseTo(afterMouseToggle, 0);

  await page.locator("[data-dialogue-new-replies]").click();
  await expect.poll(() => atBottom(page)).toBeLessThanOrEqual(8);
  await caption.focus();
  await caption.press("Enter");
  await expect(caption).toHaveAttribute("aria-expanded", "false");
  const afterKeyboardToggle = await scroller(page).evaluate(element => element.scrollTop);
  await publish(page, 12, "work-reply-2", "A second reply must not recapture the reader.");
  await expect(page.getByText("A second reply must not recapture the reader.")).toHaveCount(1);
  await expect(scroller(page).locator("[data-key]").last()).toContainText("A second reply must not recapture the reader.");
  expect(await scroller(page).evaluate(element => element.scrollTop)).toBeCloseTo(afterKeyboardToggle, 0);

  await scroller(page).focus();
  await page.keyboard.press("Home");
  await expect.poll(() => scroller(page).evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => atBottom(page)).toBeLessThanOrEqual(8);
  await publish(page, 12, "work-reply-3", "Following resumes after the reader returns to the bottom.");
  await expect(page.getByText("Following resumes after the reader returns to the bottom.")).toBeVisible();
  await expect.poll(() => atBottom(page)).toBeLessThanOrEqual(8);
});
