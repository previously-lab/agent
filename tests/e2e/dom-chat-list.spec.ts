import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import { clearEpisodic } from "./memory-fixture";

async function fixture(page: Page, count: number, question?: string) {
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
      assistantId: `work-${index}`,
      offersUrl: `/fixture/offers/${parentRunId}`,
      thoughtsUrl: `/fixture/thoughts/${parentRunId}`,
      acceptedAt: at,
      userMessage: {
        id: inputId,
        role: "user",
        metadata: { sourceInputId: inputId, acceptedAt: at },
        parts: [{ type: "text", text: question ?? `Question ${index}: ${"Enough text to make the stream scrollable. ".repeat(10)}` }],
      },
      done: false,
    };
  });
  await page.addInitScript(records => {
    localStorage.setItem("previously:dialogue:parents:v2:user", JSON.stringify(records));
    const encoder = new TextEncoder();
    const texts = new Map<string, string>();
    const inputs = new Map<string, string>();
    const parents = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const originalFetch = window.fetch;
    const publishTarget = window as unknown as {
      fixturePublish: (input: { parentRunId: string; offerId: string; runId: string; sourceInputId: string; text: string; done?: boolean }) => void;
    };
    publishTarget.fixturePublish = ({ parentRunId, offerId, runId, sourceInputId, text, done }) => {
      texts.set(runId, text);
      inputs.set(runId, sourceInputId);
      const controller = parents.get(parentRunId);
      if (!controller) throw new Error(`Parent stream not ready: ${parentRunId}`);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "offer", offerId, runId, sourceInputId,
      })}\n\n`));
      if (done) {
        controller.enqueue(encoder.encode('data: {"type":"done","status":"completed","deliveryStatus":"delivered"}\n\n'));
        controller.close();
      }
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
          { type: "data-dialogue-publication", data: { utteranceId: runId, publicSeq: inputs.size,
            inputIds: [inputs.get(runId) ?? runId.replace("run-", "input-")], sourceResults: [],
            committedAt: new Date().toISOString(), blocks: [{ kind: "markdown", blockId: "body", text }] } },
          { type: "finish" },
        ];
        const body = [...events.map(event => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("");
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    };
  }, records);
}

async function publish(page: Page, index: number, offerId: string, text: string, done = false) {
  await page.evaluate(input => {
    (window as unknown as {
      fixturePublish: (value: typeof input) => void;
    }).fixturePublish(input);
  }, { parentRunId: `parent-${index}`, offerId, runId: `run-${offerId}`, sourceInputId: `input-${index}`, text, done });
}

const scroller = (page: Page) => page.locator("[data-conversation-field]");
const atBottom = (page: Page) => scroller(page).evaluate(
  element => element.scrollHeight - element.clientHeight - element.scrollTop,
);

test.beforeEach(async () => {
  await clearEpisodic();
});

for (const width of [390, 1280]) {
  test(`activity and successive public bubbles stay with their question at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 880 });
    await fixture(page, 1, "帮我找找，上次看展的时候，我们为什么在最后一间展厅多待了一会儿？");
    let allowFinal = false;
    await page.route("**/fixture/thoughts/**", route => {
      const start = Number(new URL(route.request().url()).searchParams.get("startIndex"));
      const events = [
        { type: "reasoning", delta: "先从那次展览的档案开始。我想核对当时留下的那段描述。" },
        { type: "tool", toolCallId: "doc", toolName: "recallRead", subject: "周末的展览", state: "running" },
        { type: "tool", toolCallId: "doc", toolName: "recallRead", state: "completed", outcome: "found" },
        { type: "reasoning", delta: "找到展厅的记录了。再核对一下，你提到的究竟是哪一幅画。" },
      ].slice(0, allowFinal ? 4 : 2);
      const cursor = events.length;
      const frames = events.slice(start).map((event, i) => ({ ...event, workId: "work-1", runId: "parent-1", cursor: start + i + 1 }));
      const status = { type: "status", status: allowFinal ? "completed" : "live", workId: "work-1", runId: "parent-1",
        cursor, ...(allowFinal ? {} : { retryAfterMs: 200 }) };
      return route.fulfill({ contentType: "text/event-stream", body: [...frames, status].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") });
    });
    await page.goto("/zh/app");
    const seat = page.locator("[data-dialogue-work-turn='work-1']");
    const header = seat.locator("[data-dialogue-work-caption]");
    await expect(header).toContainText("周末的展览");
    await header.click();
    const log = seat.locator("[data-dialogue-thought-content]");
    await expect(log).toContainText("先从那次展览的档案开始");
    const partial = "你们多待了一会儿，是为了再看一眼窗边那幅水景画。";
    await publish(page, 1, "gallery-part", partial);
    await expect(seat.locator(".dialogue-continuous-reply")).toContainText(partial);
    const capture = (name: string) => page.screenshot({ path: info.outputPath(name), animations: "disabled", style: "nextjs-portal { display: none; }" });
    await capture("activity.png");
    allowFinal = true;
    await expect(log.locator("li").last()).toContainText("是哪一幅画");
    await header.click();
    const final = "你是在等那束光。记录里写着，窗边的光从画框上慢慢移开以后，你才看清水面那一层很淡的蓝。";
    await publish(page, 1, "gallery-final", final, true);
    await expect(seat.locator(".dialogue-continuous-reply")).toContainText(final);
    await expect(seat.locator(".dialogue-continuous-reply")).toContainText(partial);
    await expect(header).toContainText("已完成");
    await expect(seat.locator(".conversation-turn")).toHaveCount(1);
    expect(await page.locator("[data-conversation-field]").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const newReplies = page.locator("[data-dialogue-new-replies]");
    if (await newReplies.isVisible()) await newReplies.click();
    await capture("replies.png");
  });
}

test("restores a full pending public reply through browser storage overflow", async ({ page }) => {
  const sent = "A verified long answer. ".repeat(800) + "Final sentence restored.";
  await fixture(page, 1, "Keep the whole reply after I refresh.");
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("previously:dialogue:parents:") && value.includes("A verified long answer.")) {
        throw new DOMException("Simulated Web Storage quota", "QuotaExceededError");
      }
      write.call(this, key, value);
    };
  });
  await page.goto("/en/app");
  const seat = page.locator('[data-key="dialogue-work:work-1"]');
  await expect(seat).toBeVisible();
  await publish(page, 1, "big", sent, true);
  await expect(seat.locator("[data-public-utterance]")).toHaveText(sent);
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).some(([key, value]) =>
    key.startsWith("previously:dialogue:parents:") && value.startsWith("previously-idb:")))).toBe(true);
  await page.reload();
  await expect(seat.locator("[data-public-utterance]")).toHaveText(sent);
});

test("mounts every item, leaves an upward reader alone, and follows from the bottom", async ({ page }) => {
  await fixture(page, 18);
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
  await fixture(page, 12);
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
