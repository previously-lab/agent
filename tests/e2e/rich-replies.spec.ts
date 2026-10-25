import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
  type FixtureSlice,
} from "./memory-fixture";

const NATIVE_STORE = "previously:native-replies:v1";

async function openConversation(page: Page): Promise<void> {
  const expand = page.getByRole("button", { name: "Expand to full screen" });
  const retry = page.locator("[data-chat-arrival-error]").getByRole("button", { name: "Retry", exact: true });
  const textarea = page.locator(".conversation-composer textarea");
  await expect(expand.or(retry).or(textarea).first()).toBeVisible({ timeout: 30_000 });
  if (await retry.isVisible()) await retry.click();
  await expect(expand.or(textarea).first()).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  await expect(textarea).toBeVisible();
}

function nativeSlice(content: string, extraTurns = 0): FixtureSlice {
  const at = new Date().toISOString();
  const slice = makeSlice(at, { tag: "NATIVE" });
  delete slice.closedBy;
  delete slice.end;
  slice.turns = [
    { role: "user", at, content: "Fictional native question", turnId: "native-turn", clientMessageId: "native-question" },
    { role: "agent", at, content, turnId: "native-turn" },
  ];
  for (let index = 0; index < extraTurns; index++) {
    slice.turns.push(
      { role: "user", at, content: `Fictional filler question ${index}`, turnId: `filler-${index}` },
      { role: "agent", at, content: `Fictional filler answer ${index}. ${"Long reading text. ".repeat(12)}`, turnId: `filler-${index}` },
    );
  }
  return slice;
}

function nativeFixture({
  value = 10,
  script = "",
  markup = "",
}: {
  value?: number;
  script?: string;
  markup?: string;
} = {}): string {
  return [
    "Before the **native fixture**.",
    "```html live",
    `<section><label for="amount">Amount</label><input id="amount" type="range" min="0" max="100" value="${value}"><output id="value">${value}</output>`,
    `<svg data-native-svg viewBox="0 0 20 20" aria-label="Fixture circle"><circle id="amount-circle" cx="10" cy="10" r="${4 + value / 10}"/></svg>`,
    markup,
    "<script>",
    "document.documentElement.dataset.nativeRun=Math.random().toString(36).slice(2);",
    "const amount=document.getElementById('amount');",
    "const update=()=>{document.getElementById('value').textContent=amount.value;document.getElementById('amount-circle').setAttribute('r',String(4+Number(amount.value)/10))};",
    "amount.addEventListener('input',update);update();",
    script,
    "</script>",
    "</section>",
    "```",
    "After the native fixture.",
  ].join("\n");
}

async function setRange(page: Page, value: number, index = 0, turnId?: string, blockId?: string): Promise<void> {
  const frame = blockId
    ? page.frameLocator(`[data-native-block="${blockId}"] iframe`)
    : turnId
      ? page.frameLocator(`[data-native-turn="${turnId}"] iframe`)
      : page.frameLocator("[data-native-frame]").nth(index);
  await frame.locator("#amount").evaluate((input, next) => {
    const range = input as HTMLInputElement;
    range.value = String(next);
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function rangeValue(page: Page, index = 0, turnId?: string): Promise<string> {
  const frame = turnId
    ? page.frameLocator(`[data-native-turn="${turnId}"] iframe`)
    : page.frameLocator("[data-native-frame]").nth(index);
  return frame.locator("#amount").inputValue();
}

async function outputValue(page: Page, index = 0): Promise<string> {
  return page.frameLocator("[data-native-frame]").nth(index).locator("#value").innerText();
}

async function circleRadius(page: Page, index = 0): Promise<string | null> {
  return page.frameLocator("[data-native-frame]").nth(index).locator("#amount-circle").getAttribute("r");
}

async function nativeRun(page: Page, index = 0): Promise<string | null> {
  const root = page.frameLocator("[data-native-frame]").nth(index).locator("html");
  await expect(root).toHaveAttribute("data-native-run", /.+/);
  return root.getAttribute("data-native-run");
}

async function storedControlValues(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    const envelope = JSON.parse(localStorage.getItem(key) ?? '{"entries":[]}') as { entries?: { json: string }[] };
    return (envelope.entries ?? []).flatMap((entry) => {
      const state = JSON.parse(entry.json) as { controls?: { value: unknown }[] };
      return (state.controls ?? []).map((control) => String(control.value));
    });
  }, NATIVE_STORE);
}

async function seedAndOpen(page: Page, content: string, persona = "user"): Promise<void> {
  await seedSlices([nativeSlice(content)]);
  await page.goto(`/en/app?persona=${encodeURIComponent(persona)}`);
  await openConversation(page);
  await expect(page.locator("[data-native-frame]").first()).toBeVisible({ timeout: 30_000 });
}

async function installStagedSse(page: Page, events: Record<string, unknown>[]) {
  await page.addInitScript((chunks) => {
    const original = window.fetch;
    const mock = window as unknown as {
      __stagedNext: () => number;
      __stagedPosts: number;
      __stagedUserId: string;
    };
    mock.__stagedPosts = 0;
    mock.__stagedUserId = "";
    mock.__stagedNext = () => 0;
    window.fetch = (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname !== "/api/chat" || method !== "POST") return original(input, init);
      mock.__stagedPosts++;
      if (typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as { messages?: { id?: string }[] };
          mock.__stagedUserId = body.messages?.at(-1)?.id ?? "";
        } catch {
          mock.__stagedUserId = "";
        }
      }
      const queue = [...chunks];
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mock.__stagedNext = () => {
            const chunk = queue.shift();
            if (chunk) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              return queue.length + 1;
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return 0;
          };
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    };
  }, events);
  return {
    next: () => page.evaluate(() => (window as unknown as { __stagedNext: () => number }).__stagedNext()),
    posts: () => page.evaluate(() => (window as unknown as { __stagedPosts: number }).__stagedPosts),
    userId: () => page.evaluate(() => (window as unknown as { __stagedUserId: string }).__stagedUserId),
  };
}

test.beforeEach(async () => {
  await clearCases();
  await clearEpisodic();
});

test.afterEach(async () => {
  await clearCases();
  await clearEpisodic();
});

test("mock SSE keeps completed native DOM stable through later prose, diagrams, resize and completion", async ({ page }) => {
  test.setTimeout(120_000);
  const complete = nativeFixture({ value: 20 });
  const fenceStart = complete.indexOf("```html live");
  const fenceEnd = complete.indexOf("```", fenceStart + 12) + 3;
  const fence = complete.slice(fenceStart, fenceEnd);
  const split = Math.floor(fence.length * 0.55);
  const events: Record<string, unknown>[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "Leading **bo" },
    { type: "text-delta", id: "text", delta: `ld**.\n\n${fence.slice(0, split)}` },
    { type: "text-delta", id: "text", delta: `${fence.slice(split)}\n\nMiddle prose.\n\n\`\`\`mermaid\ngraph TD; A-->B;\n\`\`\`\n\n\`\`\`js\nconsole.log('code only');\n\`\`\`` },
    { type: "text-delta", id: "text", delta: "\n\nFinal prose." },
    { type: "text-end", id: "text" },
    { type: "tool-input-available", toolCallId: "fixture-tool", toolName: "offlineFixture", input: {} },
    { type: "tool-output-available", toolCallId: "fixture-tool", toolName: "offlineFixture", output: { ok: true } },
    { type: "start-step" },
    { type: "text-start", id: "text-2" },
    { type: "text-delta", id: "text-2", delta: fence },
    { type: "text-end", id: "text-2" },
    { type: "data-turn-status", id: "turn-status-terminal", data: { status: "done", turnId: "native-live-turn" } },
    { type: "finish" },
  ];
  await page.addInitScript((chunks) => {
    const original = window.fetch;
    const mock = window as unknown as { __nativeNext: () => number; __nativePosts: number };
    mock.__nativePosts = 0;
    mock.__nativeNext = () => 0;
    window.fetch = (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname !== "/api/chat" || method !== "POST") return original(input, init);
      mock.__nativePosts++;
      const queue = [...chunks];
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          mock.__nativeNext = () => {
            const chunk = queue.shift();
            if (chunk) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              return queue.length + 1;
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return 0;
          };
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "x-workflow-run-id": "native-mock-run" },
      }));
    };
  }, events);
  const next = () => page.evaluate(() => (window as unknown as { __nativeNext: () => number }).__nativeNext());
  const posts = () => page.evaluate(() => (window as unknown as { __nativePosts: number }).__nativePosts);

  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await page.goto("/en/app");
  await openConversation(page);
  await page.getByRole("textbox", { name: "Send a message..." }).fill("Start the fictional rich reply");
  await page.getByRole("textbox", { name: "Send a message..." }).press("Enter");
  await expect.poll(posts).toBe(1);
  await next();
  await next();
  await next();
  await next();
  await expect(page.locator(".conversation-prose strong").filter({ hasText: "bo" })).toBeVisible();
  await next();
  await expect(page.locator(".native-preparing").last()).toBeVisible();
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  await next();
  await expect(page.locator("[data-native-frame]")).toBeVisible();
  const run = await nativeRun(page);
  expect(run).not.toBeNull();
  await setRange(page, 42);
  await next();
  await expect(page.getByText("Final prose.", { exact: true })).toBeVisible();
  expect(await nativeRun(page)).toBe(run);
  expect(await rangeValue(page)).toBe("42");
  await page.setViewportSize({ width: 1024, height: 760 });
  expect(await nativeRun(page)).toBe(run);
  for (let index = 0; index < 6; index++) await next();
  await expect(page.locator('[data-native-block="native-0"]')).toHaveCount(1);
  await next();
  await expect(page.locator('[data-native-block="native-1"]')).toHaveCount(1);
  await setRange(page, 17, 1);
  await expect.poll(() => storedControlValues(page)).toContain("17");
  expect(await nativeRun(page)).toBe(run);
  expect(await rangeValue(page)).toBe("42");
  expect(await rangeValue(page, 1)).toBe("17");
  for (let index = 0; index < 2; index++) await next();
  await expect(page.locator(".streaming-content")).toHaveCount(0);
  const mermaid = page.locator('.code-block svg[id^="mmd-"]').first();
  await expect(mermaid).toBeVisible({ timeout: 30_000 });
  expect(await mermaid.getAttribute("id")).toMatch(/^mmd-/);
  expect(await mermaid.evaluate((svg) => svg.querySelectorAll("*").length)).toBeGreaterThan(3);
  expect(await nativeRun(page)).toBe(run);
  expect(await rangeValue(page)).toBe("42");
  await expect(page.locator(".language-js").filter({ hasText: "console.log" })).toBeVisible();
  expect(await posts()).toBe(1);

  const storedScopes = await page.evaluate((key) => {
    const envelope = JSON.parse(localStorage.getItem(key) ?? '{"entries":[]}') as { entries?: { scope: string }[] };
    return (envelope.entries ?? []).map((entry) => entry.scope);
  }, NATIVE_STORE);
  expect(storedScopes.some((scope) => scope.includes("native-live-turn"))).toBe(true);
});

test("identical blocks in one history turn restore independent states after reload", async ({ page }) => {
  test.setTimeout(120_000);
  const content = nativeFixture({ value: 10 });
  const start = content.indexOf("```html live");
  const end = content.indexOf("```", start + 12) + 3;
  const fence = content.slice(start, end);
  await seedSlices([nativeSlice(`${fence}\n\n${fence}`)]);
  await page.goto("/en/app");
  await openConversation(page);
  await setRange(page, 41, 0, undefined, "native-0");
  await expect.poll(() => storedControlValues(page)).toContain("41");
  await setRange(page, 19, 0, undefined, "native-1");
  await expect.poll(() => storedControlValues(page)).toContain("19");
  await page.reload();
  await openConversation(page);
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = 0; });
  const first = page.frameLocator('[data-native-block="native-0"] iframe');
  await expect(page.locator('[data-native-block="native-0"] iframe')).toBeVisible();
  expect(await first.locator("#amount").inputValue()).toBe("41");
  expect(await first.locator("#value").innerText()).toBe("41");
  expect(await first.locator("#amount-circle").getAttribute("r")).toBe("8.1");
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const second = page.frameLocator('[data-native-block="native-1"] iframe');
  await expect(page.locator('[data-native-block="native-1"] iframe')).toBeVisible();
  expect(await second.locator("#amount").inputValue()).toBe("19");
  expect(await second.locator("#value").innerText()).toBe("19");
  expect(await second.locator("#amount-circle").getAttribute("r")).toBe("5.9");
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 860, mobile: false },
  { name: "narrow mobile", width: 390, height: 844, mobile: true },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile });

    test("history controls survive resize, fold and reload; reduced motion and source versions reset cleanly", async ({ page }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const fixtureSlice = nativeSlice(nativeFixture({ value: 10 }));
      await seedSlices([fixtureSlice]);
      await page.goto("/en/app");
      await openConversation(page);
      await expect(page.locator("[data-native-frame]")).toBeVisible({ timeout: 30_000 });
      const block = page.locator("[data-native-block]").first();
      await expect(block).toHaveCSS("animation-name", "none");
      const rect = await block.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
      await setRange(page, 64);
      await expect.poll(() => storedControlValues(page)).toContain("64");
      const run = await nativeRun(page);
      const source = block.getByRole("button", { name: "Source", exact: true });
      await source.focus();
      await page.keyboard.press("Enter");
      await expect(block.locator(".native-source")).toBeVisible();
      await block.getByRole("button", { name: "Expand", exact: true }).click();
      await expect(block).toHaveClass(/native-html--expanded/);
      expect(await nativeRun(page)).toBe(run);
      await page.setViewportSize({ width: viewport.mobile ? 430 : 1100, height: viewport.height });
      expect(await rangeValue(page)).toBe("64");
      await page.locator(".conversation-composer textarea").press("Escape");
      await page.getByRole("button", { name: "Expand to full screen" }).click();
      expect(await nativeRun(page)).toBe(run);
      expect(await rangeValue(page)).toBe("64");
      await page.reload();
      await openConversation(page);
      expect(await rangeValue(page)).toBe("64");
      expect(await outputValue(page)).toBe("64");
      expect(await circleRadius(page)).toBe("10.4");
      fixtureSlice.turns[1].content = nativeFixture({ value: 35 });
      await seedSlices([fixtureSlice]);
      await page.reload();
      await openConversation(page);
      expect(await rangeValue(page)).toBe("35");
      expect(await outputValue(page)).toBe("35");
      expect(await circleRadius(page)).toBe("7.5");
    });
  });
}

test("virtualization remount restores control state", async ({ page }) => {
  test.setTimeout(120_000);
  await seedSlices([nativeSlice(nativeFixture({ value: 12 }), 28)]);
  await page.goto("/en/app");
  await openConversation(page);
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator("[data-native-frame]")).toBeVisible();
  await setRange(page, 61);
  await expect.poll(() => storedControlValues(page)).toContain("61");
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator("[data-native-frame]")).toBeVisible();
  expect(await rangeValue(page)).toBe("61");
});

test("persona scopes do not leak control state", async ({ page }) => {
  await seedAndOpen(page, nativeFixture({ value: 10 }), "alpha");
  await setRange(page, 67);
  await expect.poll(() => storedControlValues(page)).toContain("67");
  await page.goto("/en/app?persona=beta");
  await openConversation(page);
  expect(await rangeValue(page)).toBe("10");
  await page.goto("/en/app?persona=alpha");
  await openConversation(page);
  expect(await rangeValue(page)).toBe("67");
});

test("sandbox denies parent, storage and network; only host acceptance appends once", async ({ page }) => {
  const malicious = nativeFixture({
    markup: '<button id="follow" type="button">Suggest a next step</button>',
    script: `
      document.documentElement.dataset.parentAccess='denied';
      try { window.parent.document.documentElement; document.documentElement.dataset.parentAccess='allowed'; } catch {}
      document.documentElement.dataset.storageAccess='denied';
      try { window.localStorage.getItem('secret'); document.documentElement.dataset.storageAccess='allowed'; } catch {}
      document.documentElement.dataset.fetchDenied='pending';
      fetch('https://example.com/never').then(()=>{document.documentElement.dataset.fetchDenied='no'}).catch(()=>{document.documentElement.dataset.fetchDenied='yes'});
      window.previously.suggestFollowup('Onload suggestion');
      window.previously.suggestFollowup('Onload suggestion');
      document.getElementById('follow').addEventListener('click',()=>window.previously.suggestFollowup('Button suggestion'));
    `,
  });
  let posts = 0;
  let external = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") posts++;
    if (request.url().startsWith("https://example.com")) external++;
  });
  await seedAndOpen(page, malicious);
  const frame = page.frameLocator("[data-native-frame]").first();
  await expect(frame.locator("html")).toHaveAttribute("data-parent-access", "denied");
  await expect(frame.locator("html")).toHaveAttribute("data-storage-access", "denied");
  await expect(frame.locator("html")).toHaveAttribute("data-fetch-denied", "yes");
  const input = page.getByRole("textbox", { name: "Send a message..." });
  await expect(input).toHaveValue("");
  await expect(page.locator("[data-native-suggestion]")).toHaveCount(1);
  await input.fill("Existing draft");
  await page.locator(".conversation-composer input[type=file]").setInputFiles({
    name: "fixture-note.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64"),
  });
  await frame.locator("#follow").click();
  await frame.locator("#follow").click();
  await expect(page.locator("[data-native-suggestion]")).toHaveCount(1);
  await expect(page.locator("[data-native-suggestion]")).toContainText("Button suggestion");
  const accept = page.getByRole("button", { name: "Add to draft", exact: true });
  await accept.focus();
  await page.keyboard.press("Space");
  await expect(input).toHaveValue("Existing draft\n\nButton suggestion");
  await expect(page.getByRole("button", { name: "Remove attachment: fixture-note.png" })).toBeVisible();
  await expect(page.locator("[data-native-suggestion]")).toHaveCount(0);
  await frame.locator("#follow").click();
  await expect(page.locator("[data-native-suggestion]")).toHaveCount(0);
  await expect(input).toHaveValue("Existing draft\n\nButton suggestion");
  expect(posts).toBe(0);
  expect(external).toBe(0);
});

test("terminal incomplete source stays readable and inert, with keyboard-accessible controls", async ({ page }) => {
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") posts++;
  });
  await seedSlices([nativeSlice("Before incomplete.\n```html live\n<script>window.partialExecuted=true</script>")]);
  await page.goto("/en/app");
  await openConversation(page);
  const incomplete = page.locator("[data-native-incomplete]");
  await expect(incomplete).toBeVisible();
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  const source = incomplete.getByRole("button", { name: "Source", exact: true });
  await source.focus();
  await page.keyboard.press("Enter");
  await expect(incomplete.locator(".native-source")).toContainText("window.partialExecuted=true");
  await incomplete.getByRole("button", { name: "Retry", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("textbox", { name: "Send a message..." })).toHaveValue("Please finish the incomplete interactive HTML block from the previous reply.");
  expect(posts).toBe(0);
});

test("paper copies never run duplicate scripts and open only one deliberate interactive view", async ({ page }) => {
  test.setTimeout(120_000);
  const body = [
    "# Fictional native paper",
    "```html live",
    "<p>Readable static native summary.</p><script>document.documentElement.dataset.paperScript='ran'</script>",
    "```",
    ...Array.from({ length: 18 }, (_, index) => `## Section ${index + 1}\n\n${"Fixed printable prose. ".repeat(18)}`),
  ].join("\n\n");
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await seedCases([{ category: "research", name: "native-paper", opened: "2026-02-01", body, pieces: [] }]);
  await page.goto("/en/app?view=field");
  await page.locator('[data-archive-pile="research/native-paper"]').click();
  await expect(page.locator(".desk-shell--top .desk-title")).toHaveText("native-paper");
  await expect.poll(async () => Number((await page.locator(".desk-page-position").innerText()).split("/")[1])).toBeGreaterThan(1);
  const staticFrames = page.locator('[data-native-mode="paper"] iframe');
  await expect(staticFrames.first()).toBeVisible();
  expect(await staticFrames.count()).toBeGreaterThanOrEqual(2);
  expect(await staticFrames.evaluateAll((frames) => frames.every((frame) => frame.getAttribute("sandbox") === ""))).toBe(true);
  const scriptRuns = async () => {
    let count = 0;
    for (const frame of page.frames()) count += await frame.locator('html[data-paper-script="ran"]').count();
    return count;
  };
  expect(await scriptRuns()).toBe(0);
  const position = await page.locator(".desk-page-position").innerText();
  await page.locator(".desk-shell--top [data-native-block]").getByRole("button", { name: "Open interactive", exact: true }).click();
  await expect(page.locator("dialog.native-dialog iframe[sandbox='allow-scripts']")).toHaveCount(1);
  await expect.poll(scriptRuns).toBe(1);
  await page.getByRole("button", { name: "Close interactive view", exact: true }).click();
  await expect(page.locator("dialog.native-dialog")).toHaveCount(0);
  expect(await scriptRuns()).toBe(0);
  await expect(page.locator(".desk-page-position")).toHaveText(position);
});

test("timed chunks do not replay settled prose or replace the completed iframe", async ({ page }) => {
  test.setTimeout(120_000);
  const content = nativeFixture({ value: 20 });
  const start = content.indexOf("```html live");
  const end = content.indexOf("```", start + 12) + 3;
  const fence = content.slice(start, end);
  const events: Record<string, unknown>[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "First settled paragraph." },
    { type: "text-delta", id: "text", delta: `\n\n${fence}` },
    { type: "text-delta", id: "text", delta: "\n\nSecond arriving paragraph." },
    { type: "text-delta", id: "text", delta: "\n\nThird arriving paragraph." },
    { type: "text-end", id: "text" },
    { type: "data-turn-status", id: "turn-status-terminal", data: { status: "done", turnId: "timed-native-turn" } },
    { type: "finish" },
  ];
  await page.addInitScript((chunks) => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname !== "/api/chat" || method !== "POST") return original(input, init);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, 160));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "x-workflow-run-id": "timed-native-run" },
      }));
    };
  }, events);
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await page.goto("/en/app");
  await openConversation(page);
  await page.getByRole("textbox", { name: "Send a message..." }).fill("Start the timed fictional reply");
  await page.getByRole("textbox", { name: "Send a message..." }).press("Enter");
  await expect(page.getByText("First settled paragraph.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-native-frame]")).toBeVisible();
  const run = await nativeRun(page);
  await page.evaluate(() => {
    const paragraph = Array.from(document.querySelectorAll(".streaming-content > p"))
      .find((element) => element.textContent === "First settled paragraph.");
    if (!paragraph) throw new Error("Settled paragraph not found");
    const probe = window as unknown as {
      __animationStarts: number;
      __paragraph: Element;
      __frame: Element | null;
    };
    probe.__animationStarts = 0;
    probe.__paragraph = paragraph;
    probe.__frame = document.querySelector("[data-native-frame]");
    paragraph.addEventListener("animationstart", () => { probe.__animationStarts += 1; });
  });
  await expect(page.getByText("Third arriving paragraph.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".streaming-content")).toHaveCount(0, { timeout: 30_000 });
  const stability = await page.evaluate(() => {
    const probe = window as unknown as {
      __animationStarts: number;
      __paragraph: Element;
      __frame: Element | null;
    };
    return {
      starts: probe.__animationStarts,
      paragraphSame: probe.__paragraph === Array.from(document.querySelectorAll("p"))
        .find((element) => element.textContent === "First settled paragraph."),
      frameSame: probe.__frame === document.querySelector("[data-native-frame]"),
    };
  });
  expect(stability).toEqual({ starts: 0, paragraphSame: true, frameSame: true });
  expect(await nativeRun(page)).toBe(run);
});

test("early script errors survive ready and script-only content keeps a readable fallback", async ({ page }) => {
  await seedAndOpen(page, "```html live\n<script>throw new Error('early fixture')</script>\n```");
  const frame = page.frameLocator("[data-native-frame]").first();
  await expect(frame.locator("#previously-native-fallback")).toBeVisible();
  await expect(page.locator(".native-error")).toContainText("script problem");
  await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
});

test("a second iframe load removes the navigated document and leaves recovery controls", async ({ page }) => {
  const navigating = nativeFixture({
    script: "setTimeout(()=>{window.location.assign('about:blank')},1000);",
  });
  await seedAndOpen(page, navigating);
  await expect(page.locator("[data-native-frame]")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".native-preparing-label")).toContainText("navigate away");
  await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
});

test("native height follows content both ways and expansion adds room", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = nativeFixture({
    markup: '<button id="details" type="button">Toggle details</button><div id="details-panel" hidden><div style="height:1400px">Tall fictional details</div></div>',
    script: `
      const panel=document.getElementById('details-panel');
      document.getElementById('details').addEventListener('click',()=>{panel.hidden=!panel.hidden});
      document.documentElement.dataset.detailsReady='yes';
    `,
  });
  await seedAndOpen(page, fixture);
  const frame = page.frameLocator("[data-native-frame]").first();
  const shell = page.locator(".native-frame-shell").first();
  const run = await nativeRun(page);
  const height = async () => (await shell.boundingBox())?.height ?? 0;
  await expect.poll(height).toBeGreaterThan(300);
  await expect.poll(height).toBeLessThan(900);
  const noInnerOverflow = await frame.locator("html").evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1);
  expect(noInnerOverflow).toBe(true);
  await expect(frame.locator("html")).toHaveAttribute("data-details-ready", "yes");
  await expect(page.locator(".conversation-panel .pulse-delay")).toHaveCount(0);
  await frame.locator("#details").click();
  await expect(frame.locator("#details-panel")).toBeVisible();
  await expect.poll(height).toBe(1024);
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect.poll(height).toBeGreaterThan(1024);
  await frame.locator("#details").focus();
  await page.keyboard.press("Space");
  await expect.poll(height).toBeLessThan(900);
  expect(await nativeRun(page)).toBe(run);
});

test("identical sources in ordinary turns keep independent persisted scopes", async ({ page }) => {
  test.setTimeout(120_000);
  const slice = nativeSlice(nativeFixture({ value: 10 }));
  const at = new Date().toISOString();
  slice.turns.push(
    { role: "user", at, content: "Second fictional native question", turnId: "other-native-turn" },
    { role: "agent", at, content: nativeFixture({ value: 10 }), turnId: "other-native-turn" },
  );
  await seedSlices([slice]);
  await page.goto("/en/app");
  await openConversation(page);
  await expect(page.locator('[data-native-turn="native-turn"] iframe')).toBeVisible();
  await expect(page.locator('[data-native-turn="other-native-turn"] iframe')).toBeVisible();
  await setRange(page, 71, 0, "native-turn");
  await expect.poll(() => storedControlValues(page)).toContain("71");
  expect(await rangeValue(page, 0, "other-native-turn")).toBe("10");
  await setRange(page, 22, 0, "other-native-turn");
  expect(await rangeValue(page, 0, "native-turn")).toBe("71");
  await expect.poll(() => storedControlValues(page)).toContain("22");
  await page.reload();
  await openConversation(page);
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator('[data-native-turn="native-turn"] iframe')).toBeVisible();
  expect(await rangeValue(page, 0, "native-turn")).toBe("71");
  await page.locator("[data-conversation-field]").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('[data-native-turn="other-native-turn"] iframe')).toBeVisible();
  expect(await rangeValue(page, 0, "other-native-turn")).toBe("22");
});

for (const viewport of [
  { name: "desktop-1440", width: 1440, height: 1000 },
  { name: "phone-390", width: 390, height: 844 },
]) {
  test(`reduced-motion rich reply visual checkpoint ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const content = [
      "## A little room for the unplanned",
      nativeFixture({ value: 24, markup: "<p>Fictional hours; adjust the slider to recompute the output and circle.</p>" }),
      "3. Complete the most important draft.\n   1. State the core judgment.\n      - Keep the evidence and the open questions.\n   2. Edit the prose.\n4. Take a walk.",
      "- [x] Leave room for rest\n- [ ] Decide what matters next",
      "| Content | Approach |\n| :--- | ---: |\n| Required work | Protected time |\n| Unplanned events | Reserved space |",
      "```mermaid\nflowchart LR\n  A[Leave space] --> B[Try a plan]\n  B --> C[Observe]\n```",
      "$t_{free}=40-t_{planned}$",
    ].join("\n\n");
    await seedSlices([nativeSlice(content)]);
    await page.goto("/en/app");
    await openConversation(page);
    const block = page.locator("[data-native-block]").first();
    await expect(block).toHaveCSS("animation-name", "none");
    await expect(page.locator('.code-block svg[id^="mmd-"]').first()).toBeVisible({ timeout: 30_000 });
    await block.scrollIntoViewIfNeeded();
    const frame = page.frameLocator("[data-native-frame]").first();
    await expect(page.locator(".native-frame-shell").first()).toHaveAttribute("data-ready");
    await expect.poll(async () => frame.locator("html").evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    const bounds = await block.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath(`native-rich-${viewport.name}.png`) });
    await page.locator('.code-block svg[id^="mmd-"]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`native-rich-markdown-${viewport.name}.png`) });
  });
}

test("an EOF closing candidate and a delayed invalid suffix never execute native source", async ({ page }) => {
  test.setTimeout(120_000);
  const source = "```html live\n<script>document.documentElement.dataset.eofRan='yes'</script>\n```";
  const events: Record<string, unknown>[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: source },
    { type: "text-delta", id: "text", delta: "x\n" },
    { type: "text-end", id: "text" },
    { type: "data-turn-status", id: "turn-status-terminal", data: { status: "done", turnId: "eof-invalid-turn" } },
    { type: "finish" },
  ];
  const sse = await installStagedSse(page, events);
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await page.goto("/en/app");
  await openConversation(page);
  const input = page.getByRole("textbox", { name: "Send a message..." });
  await input.fill("Start the EOF candidate fixture");
  await input.press("Enter");
  await expect.poll(sse.posts).toBe(1);
  for (let index = 0; index < 3; index++) await sse.next();
  await sse.next();
  await expect(page.locator(".native-preparing").last()).toBeVisible();
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  await sse.next();
  await expect(page.locator(".native-preparing").last()).toBeVisible();
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  for (let index = 0; index < 3; index++) await sse.next();
  await expect(page.locator("[data-native-incomplete]")).toBeVisible();
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  let executions = 0;
  for (const frame of page.frames()) executions += await frame.locator('html[data-eof-ran="yes"]').count();
  expect(executions).toBe(0);
});

test("valid closing EOL and terminal EOF each execute once without replacing the earlier frame", async ({ page }) => {
  test.setTimeout(120_000);
  const validContent = nativeFixture({ value: 20 });
  const terminalContent = nativeFixture({ value: 30 });
  const validStart = validContent.indexOf("```html live");
  const validFence = validContent.slice(validStart, validContent.indexOf("```", validStart + 12) + 3);
  const terminalStart = terminalContent.indexOf("```html live");
  const terminalFence = terminalContent.slice(terminalStart, terminalContent.indexOf("```", terminalStart + 12) + 3);
  const events: Record<string, unknown>[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: `${validFence}\n` },
    { type: "text-delta", id: "text", delta: `\n\n${terminalFence}` },
    { type: "text-end", id: "text" },
    { type: "data-turn-status", id: "turn-status-terminal", data: { status: "done", turnId: "eof-terminal-turn" } },
    { type: "finish" },
  ];
  const sse = await installStagedSse(page, events);
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await page.goto("/en/app");
  await openConversation(page);
  const input = page.getByRole("textbox", { name: "Send a message..." });
  await input.fill("Start the valid and terminal EOF fixture");
  await input.press("Enter");
  await expect.poll(sse.posts).toBe(1);
  for (let index = 0; index < 4; index++) await sse.next();
  await expect(page.locator('[data-native-block="native-0"] iframe')).toBeVisible();
  const firstRun = await nativeRun(page);
  await sse.next();
  await expect(page.locator(".native-preparing").last()).toBeVisible();
  await expect(page.locator('[data-native-block="native-1"]')).toHaveCount(0);
  expect(await nativeRun(page)).toBe(firstRun);
  for (let index = 0; index < 3; index++) await sse.next();
  await expect(page.locator('[data-native-block="native-1"] iframe')).toBeVisible();
  expect(await nativeRun(page)).toBe(firstRun);
  await expect(page.locator(".streaming-content")).toHaveCount(0);
  expect(await nativeRun(page)).toBe(firstRun);
});

test("synchronous first-load navigation fails closed on the ready timeout", async ({ page }) => {
  test.setTimeout(120_000);
  const navigating = nativeFixture({ script: "location.replace('about:blank');" });
  await seedSlices([nativeSlice(navigating)]);
  await page.goto("/en/app");
  await openConversation(page);
  await expect(page.locator(".native-preparing-label")).toContainText("stopped or could not finish loading", { timeout: 15_000 });
  await expect(page.locator("[data-native-frame]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeVisible();
});

test("initial arrival Retry and Expand work with a real pointer", async ({ page }) => {
  test.setTimeout(90_000);
  let delayedArrival = false;
  let releaseArrival!: () => void;
  const arrivalGate = new Promise<void>((resolve) => { releaseArrival = resolve; });
  await page.route("**/en/app**", async (route) => {
    const request = route.request();
    if (!delayedArrival && request.method() === "POST" && request.headers()["next-action"] && request.postData() === "[[],[]]") {
      delayedArrival = true;
      await arrivalGate;
      await route.abort("aborted");
      return;
    }
    await route.continue();
  });
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await page.goto("/en/app");
  const arrivalError = page.locator("[data-chat-arrival-error]");
  const retry = arrivalError.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  releaseArrival();
  await retry.click();
  await expect(arrivalError).toHaveCount(0, { timeout: 5_000 });
  const expand = page.getByRole("button", { name: "Expand to full screen" });
  const composer = page.locator(".conversation-composer textarea");
  await expect(expand.or(composer).first()).toBeVisible({ timeout: 30_000 });
  if (!(await composer.isVisible()) && (await expand.isVisible())) await expand.click();
  await expect(composer).toBeVisible();
  const exit = page.getByRole("button", { name: "Exit full screen", exact: true });
  await expect(exit).toBeVisible();
  await exit.click();
  const expandAgain = page.getByRole("button", { name: "Expand to full screen" });
  await expect(expandAgain).toBeVisible();
  await expandAgain.click();
  await expect(composer).toBeVisible();
  expect(delayedArrival).toBe(true);
});

test("native state follows the resolved persona through utility navigation", async ({ page }) => {
  test.setTimeout(120_000);
  await seedAndOpen(page, nativeFixture({ value: 10 }), "alpha");
  await setRange(page, 68, 0, "native-turn");
  await expect.poll(() => storedControlValues(page)).toContain("68");
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/settings/);
  expect(page.url()).not.toContain("persona=");
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/app/);
  await openConversation(page);
  await expect(page.locator('[data-native-turn="native-turn"] iframe')).toBeVisible();
  expect(await rangeValue(page, 0, "native-turn")).toBe("68");
  await page.goto("/en/app?persona=beta");
  await openConversation(page);
  expect(await rangeValue(page, 0, "native-turn")).toBe("10");
  await page.goto("/en/app?persona=alpha");
  await openConversation(page);
  expect(await rangeValue(page, 0, "native-turn")).toBe("68");
});

test("live provisional state restores under the canonical authoritative history identity", async ({ page }) => {
  test.setTimeout(120_000);
  const content = nativeFixture({ value: 20 });
  const events: Record<string, unknown>[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: content },
    { type: "text-end", id: "text" },
    { type: "data-turn-status", id: "turn-status-terminal", data: { status: "done", turnId: "native-live-turn" } },
    { type: "finish" },
  ];
  const sse = await installStagedSse(page, events);
  await seedSlices([makeSlice("2026-02-01T09:00:00.000Z", { tag: "OLD" })]);
  await page.goto("/en/app");
  await openConversation(page);
  const input = page.getByRole("textbox", { name: "Send a message..." });
  await input.fill("Live canonical question");
  await input.press("Enter");
  await expect.poll(sse.posts).toBe(1);
  for (let index = 0; index < 4; index++) await sse.next();
  await expect(page.locator('[data-native-block="native-0"] iframe')).toBeVisible();
  await setRange(page, 46, 0, undefined, "native-0");
  expect(await outputValue(page)).toBe("46");
  await expect.poll(() => storedControlValues(page)).toContain("46");
  for (let index = 0; index < 3; index++) await sse.next();
  await expect(page.locator(".streaming-content")).toHaveCount(0);
  await expect(page.locator('[data-native-turn="native-live-turn"]')).toBeVisible();
  const canonicalScopes = await page.evaluate((key) => {
    const envelope = JSON.parse(localStorage.getItem(key) ?? '{"entries":[]}') as { entries?: { scope: string }[] };
    return (envelope.entries ?? []).map((entry) => entry.scope);
  }, NATIVE_STORE);
  expect(canonicalScopes.some((scope) => scope.includes("native-live-turn"))).toBe(true);
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem("previously:pending-persistence:v1") ?? '{"runIds":[]}') as { runIds?: string[] });
  expect(pending.runIds ?? []).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("previously:activeRunId"))).toBeNull();
  const userId = await sse.userId();
  expect(userId).not.toBe("");

  const at = new Date().toISOString();
  const saved = makeSlice(at, { tag: "NATIVE-LIVE-HISTORY" });
  delete saved.closedBy;
  delete saved.end;
  saved.turns = [
    { role: "user", at, content: "Live canonical question", turnId: "native-live-turn", clientMessageId: userId },
    { role: "agent", at, content, turnId: "native-live-turn" },
  ];
  await seedSlices([saved]);
  await page.reload();
  await openConversation(page);
  const history = page.frameLocator('[data-native-turn="native-live-turn"] iframe');
  await expect(page.locator('[data-native-turn="native-live-turn"] iframe')).toBeVisible();
  expect(await history.locator("#amount").inputValue()).toBe("46");
  expect(await history.locator("#value").innerText()).toBe("46");
  expect(await history.locator("#amount-circle").getAttribute("r")).toBe("8.6");
});
