import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const providerRoot = process.env.SCROLL_QA_PROVIDER_ROOT!;
type Frame = Record<string, unknown> | { frame: Record<string, unknown>; gateAfter: string };
const tool = (name: string, input: unknown, id: string): Frame => ({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
const release = (gate: string) => fs.writeFile(path.join(providerRoot, `release-${gate}`), "");
const gates = new Set<string>();
async function snapshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false });
}
async function send(page: Page, text: string) {
  const editor = page.locator("[data-manuscript-input]");
  await expect(editor).toBeEditable();
  const acceptance = page.waitForResponse(r => new URL(r.url()).pathname === "/api/chat" && r.request().method() === "POST");
  await editor.fill(text);
  await editor.press("Enter");
  const response = await acceptance;
  expect(response.ok()).toBeTruthy();
  const accepted = await response.json() as { version: number; workId: string; sourceInputId: string };
  expect(accepted.version).toBe(2);
  expect(accepted.workId).toBeTruthy();
  expect(accepted.sourceInputId).toBeTruthy();
  return accepted;
}

test.afterEach(async () => { await Promise.all([...gates].map(g => release(g).catch(() => {}))); gates.clear(); });

test("two real server runs keep per-prompt captions and output separate", async ({ page }, info) => {
  const token = randomUUID();
  const rules: Array<Record<string, unknown>> = [{ id: `reflection-${token}`, contains: ["hqReport"], repeat: true, finishReason: "tool_calls", frames: [tool("hqReport", { actions: [], note: "Offline interaction fixture" }, `hq-${token}`)] }];
  for (const lane of ["b", "a"]) {
    const marker = `QA${lane.toUpperCase()}-${token}`;
    const id = `${lane}-${token}`;
    const laneGuard = lane === "a" ? { excludes: [`QAB-${token}`] } : {};
    for (const prefix of ["wait", "tool", "public", "finish"]) gates.add(`${prefix}-${id}`);
    rules.push(
      { id: `analyzer-${id}`, contains: ["analyzeOutput", marker], ...laneGuard, finishReason: "tool_calls", frames: [tool("analyzeOutput", { intent: { type: "chat", reason: "Offline fixture" }, memory_worthy: false, emotional_signal: { intensity: "none", register: "neutral", note: "" } }, `analyze-${id}`)] },
      { id: `think-${id}`, contains: ["finishThinking", marker], ...laneGuard, thinking: "enabled", gate: `wait-${id}`, gateTimeoutMs: 175_000, finishReason: "tool_calls", frames: [{ content: `THOUGHT-${marker} ` + `${marker} detail. `.repeat(100) }, { frame: tool("currentTime", {}, `time-${id}`), gateAfter: `tool-${id}` }] },
      { id: `offer-${id}`, contains: ["finishThinking", marker], ...laneGuard, thinking: "enabled", finishReason: "tool_calls", frames: [tool("offerReply", { stage: "final", text: `REPLY-${marker}` }, `offer-call-${id}`)] },
      { id: `finish-${id}`, contains: ["finishThinking", marker], ...laneGuard, thinking: "enabled", gate: `finish-${id}`, gateTimeoutMs: 175_000, finishReason: "tool_calls", frames: [tool("finishThinking", { findings: [] }, `finish-call-${id}`)] },
      { id: `public-${id}`, contains: [marker], ...laneGuard, thinking: "disabled", gateTimeoutMs: 175_000, frames: [{ frame: { content: `PUBLIC-FIRST-${marker} ` }, gateAfter: `public-${id}` }, { content: `PUBLIC-LAST-${marker}` }] },
    );
  }
  const fixtureRoot = process.env.SCROLL_QA_FIXTURE_ROOT;
  expect(fixtureRoot, "Explicit isolated fixture root is required").toBeTruthy();
  expect(path.resolve(providerRoot)).toBe(path.join(path.resolve(fixtureRoot!), "home", "dialogue-provider"));
  expect(await fs.readFile(path.join(providerRoot, "scroll-qa-server-sentinel"), "utf8")).toBe("isolated-scroll-qa-3100");
  await fs.writeFile(path.join(providerRoot, "rules.json"), JSON.stringify(rules));
  const browserErrors: string[] = [];
  page.on("pageerror", e => browserErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") browserErrors.push(`console: ${m.text()}`); });
  await page.route("**/*", route => {
    const u = new URL(route.request().url());
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && u.port === "3100" ? route.continue() : route.abort("blockedbyclient");
  });
  try {
    await page.goto(`/en/app?persona=qa-${token}`);
    const a = await send(page, `QAA-${token}`);
    const seatA = page.locator(`[data-dialogue-work-turn="${a.workId}"]`);
    await expect(seatA).toBeVisible();
    const toggleA = seatA.locator("[data-dialogue-work-caption]");
    await expect(toggleA).toBeVisible();
    await snapshot(page, info, "a-waiting");
    const b = await send(page, `QAB-${token}`);
    const seatB = page.locator(`[data-dialogue-work-turn="${b.workId}"]`);
    await expect(seatB).toBeVisible();
    expect(b.workId).not.toBe(a.workId);
    await seatB.locator("[data-dialogue-work-caption]").click();
    await release(`wait-b-${token}`);
    await expect(seatB.getByRole("log")).toContainText(`THOUGHT-QAB-${token}`);
    await toggleA.click();
    await release(`wait-a-${token}`);
    await expect(seatA.getByRole("log")).toContainText(`THOUGHT-QAA-${token}`);
    await expect(seatA.getByRole("log")).not.toContainText(`QAB-${token}`);
    await expect(seatB.getByRole("log")).not.toContainText(`QAA-${token}`);
    const viewport = seatA.locator('[data-slot="scroll-area-viewport"]');
    await expect.poll(() => viewport.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const height = await viewport.evaluate(el => el.getBoundingClientRect().height);
    await viewport.hover();
    await page.mouse.wheel(0, -500);
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeLessThan(await viewport.evaluate(el => el.scrollHeight - el.clientHeight));
    await viewport.focus();
    await page.keyboard.press("End");
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await toggleA.click();
    await toggleA.click();
    await expect(seatA.getByRole("log")).toContainText(`THOUGHT-QAA-${token}`);
    expect(await viewport.evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(height, 0);
    await snapshot(page, info, "both-streams");
    await release(`tool-b-${token}`);
    await expect(seatB).toContainText(`PUBLIC-FIRST-QAB-${token}`);
    await release(`public-b-${token}`);
    await release(`finish-b-${token}`);
    await expect(seatB).toContainText(`PUBLIC-LAST-QAB-${token}`);
    await release(`tool-a-${token}`);
    await expect(seatA).toContainText(`PUBLIC-FIRST-QAA-${token}`);
    await release(`public-a-${token}`);
    await release(`finish-a-${token}`);
    await expect(seatA).toContainText(`PUBLIC-LAST-QAA-${token}`);
    await expect(seatA).not.toContainText(`PUBLIC-LAST-QAB-${token}`);
    await expect(seatB).not.toContainText(`PUBLIC-LAST-QAA-${token}`);
    await snapshot(page, info, "both-complete");
    expect(browserErrors).toEqual([]);
  } finally {
    await info.attach("browser-errors", { body: JSON.stringify(browserErrors, null, 2), contentType: "application/json" });
  }
});

test("workflow popover supports mouse and keyboard on the real server", async ({ page }, info) => {
  await page.goto(`/en/app?persona=menu-${randomUUID()}`);
  const trigger = page.getByRole("button", { name: "Workflows", exact: true });
  const panel = page.locator("[data-companion-pod-panel]");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-slot="tabs-trigger"]')).toHaveCount(2);
  await panel.locator('[data-slot="tabs-trigger"]').filter({ hasText: "Workflows" }).click();
  await snapshot(page, info, "workflows-tab");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await page.mouse.click(10, 10);
  await expect(panel).toBeHidden();
});

test("a provider failure can be retried through the real composer workflow", async ({ page }, info) => {
  const token = randomUUID();
  const marker = `RETRY-${token}`;
  const rules = [
    { id: `hq-${token}`, contains: ["hqReport"], repeat: true, finishReason: "tool_calls", frames: [tool("hqReport", { actions: [], note: "Offline" }, `hq-call-${token}`)] },
    { id: `analyze-${token}`, contains: ["analyzeOutput", marker], repeat: true, finishReason: "tool_calls", frames: [tool("analyzeOutput", { intent: {type:"chat",reason:"Offline"}, memory_worthy:false, emotional_signal:{intensity:"none",register:"neutral",note:""} }, `analyze-call-${token}`)] },
    { id: `fail-${token}`, contains: ["finishThinking", marker], thinking: "enabled", status: 400, frames: [] },
    { id: `retry-offer-${token}`, contains: ["finishThinking", marker], thinking: "enabled", finishReason: "tool_calls", frames: [tool("offerReply", { stage: "final", text: `RECOVERED-${token}` }, `offer-${token}`)] },
    { id: `retry-finish-${token}`, contains: ["finishThinking", marker], thinking: "enabled", finishReason: "tool_calls", frames: [tool("finishThinking", {findings:[]}, `finish-${token}`)] },
    { id: `retry-public-${token}`, contains: [marker], thinking: "disabled", frames: [{content:`RECOVERED-${token}`}] },
  ];
  expect(await fs.readFile(path.join(providerRoot, "scroll-qa-server-sentinel"), "utf8")).toBe("isolated-scroll-qa-3100");
  await fs.writeFile(path.join(providerRoot, "rules.json"), JSON.stringify(rules));
  await page.goto(`/en/app?persona=retry-${token}`);
  const first = await send(page, marker);
  const seat = page.locator(`[data-dialogue-work-turn="${first.workId}"]`);
  await expect(seat.locator("[data-dialogue-work-caption]")).toContainText("Reply incomplete");
  await snapshot(page, info, "provider-failed");
  await seat.getByRole("button", {name:"Try again", exact:true}).click();
  await expect(page.getByText(`RECOVERED-${token}`, {exact:true})).toBeVisible();
  await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "send");
  await snapshot(page, info, "retry-recovered");
});

test("a gated real work can be stopped without a reply", async ({ page }, info) => {
  const token = randomUUID();
  const marker = `CANCEL-${token}`;
  const gate = `cancel-${token}`;
  gates.add(gate);
  const rules = [
    { id: `hq-${token}`, contains:["hqReport"], repeat:true, finishReason:"tool_calls", frames:[tool("hqReport",{actions:[],note:"Offline"},`hq-call-${token}`)] },
    { id: `analyze-${token}`, contains:["analyzeOutput",marker], finishReason:"tool_calls", frames:[tool("analyzeOutput",{intent:{type:"chat",reason:"Offline"},memory_worthy:false,emotional_signal:{intensity:"none",register:"neutral",note:""}},`analyze-call-${token}`)] },
    { id: `think-${token}`, contains:["finishThinking",marker], thinking:"enabled", gate, gateTimeoutMs:175000, finishReason:"tool_calls", frames:[tool("finishThinking",{findings:[]},`finish-${token}`)] },
  ];
  expect(await fs.readFile(path.join(providerRoot, "scroll-qa-server-sentinel"), "utf8")).toBe("isolated-scroll-qa-3100");
  await fs.writeFile(path.join(providerRoot, "rules.json"), JSON.stringify(rules));
  await page.goto(`/en/app?persona=cancel-${token}`);
  const accepted = await send(page, marker);
  const seat = page.locator(`[data-dialogue-work-turn="${accepted.workId}"]`);
  await expect(seat.locator("[data-dialogue-work-caption]")).toBeVisible();
  const cancelResponse = page.waitForResponse(response => /\/api\/chat\/[^/]+\/cancel$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await seat.getByRole("button", {name:"Stop", exact:true}).click();
  const stopped = await cancelResponse;
  expect(stopped.ok(), `Cancel HTTP ${stopped.status()}: ${await stopped.text()}`).toBe(true);
  await expect(seat.locator("[data-dialogue-work-caption]")).toContainText("Stopped");
  await expect(page.locator("[data-conversation-primary]")).toHaveAttribute("data-primary-action", "send");
  await expect(seat.locator(".conversation-prose")).toHaveCount(0);
  await snapshot(page, info, "cancelled");
});
