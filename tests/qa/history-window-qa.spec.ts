import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

// This suite is intentionally forbidden from seeding the live manual fixture.
// The server must be started separately with MEMORY_ROOT=<fresh root>/memory.
const root = path.resolve(process.env.SCROLL_QA_HISTORY_ROOT!);
const memory = path.join(root, "memory");
const sentinel = path.join(root, "history-qa-sentinel");
const marker = "history-qa-exclusive-v1";
const p = (n: number) => String(n).padStart(2, "0");
function idFor(d: Date) { return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`; }
async function seed() {
  expect(await fs.readFile(sentinel, "utf8")).toBe(marker);
  const existing = await fs.readdir(path.join(memory, "records")).catch(() => []);
  const ready = path.join(root, "history-qa-seeded.json");
  if (existing.length) {
    const manifest = JSON.parse(await fs.readFile(ready, "utf8"));
    expect(manifest.marker).toBe(marker);
    return;
  }
  const now = Date.now();
  const slices = [
    { at: new Date(now - 180 * 60_000), label: "HISTORY-OLDER", count: 3, closed: true },
    { at: new Date(now - 90 * 60_000), label: "HISTORY-PREVIOUS", count: 36, closed: true },
    { at: new Date(now - 30_000), label: "HISTORY-CURRENT", count: 8, closed: false },
  ];
  for (const slice of slices) {
    const id = idFor(slice.at);
    const [y,m,d,hm] = id.split("-");
    const dir = path.join(memory, "records", y!, m!, d!, hm!);
    await fs.mkdir(dir, { recursive: true });
    const turns = Array.from({ length: slice.count }, (_, i) => `## Turn ${slice.label}-${i} — ${slice.at.toISOString()} (${i % 2 ? "agent" : "user"})\n\n${slice.label}-TURN-${i} ${i % 3 === 0 ? "A long record with several sentences to exercise natural height and wrapping. ".repeat(8) : "Short record."}`).join("\n\n");
    const header = [`slice_id: ${JSON.stringify(id)}`, `focus: ${JSON.stringify(slice.label)}`, `start: ${JSON.stringify(slice.at.toISOString())}`, 'timezone: "UTC"', 'summary: ""', 'open_loops: []', 'decisions: []', 'loops: []', ...(slice.closed ? ['closed_by: idle_gap'] : [])].join("\n");
    await fs.writeFile(path.join(dir, "core.md"), `---\n${header}\n---\n\n${turns}\n`, { flag: "wx" });
  }
  await fs.writeFile(ready, JSON.stringify({ marker, slices: slices.map(s => ({ id: idFor(s.at), label: s.label })) }), { flag: "wx" });
}

test("cold load keeps prior slice and current mounted while scrolling", async ({ page }, info) => {
  await seed();
  const shifts: Array<{ value: number; startTime: number; sources: unknown }> = [];
  await page.exposeFunction("recordQaShift", (value: number, startTime: number, sources: unknown) => shifts.push({ value, startTime, sources }));
  await page.addInitScript(() => {
    new PerformanceObserver(list => { for (const raw of list.getEntries()) {
      const e = raw as PerformanceEntry & { value: number; hadRecentInput: boolean; sources: Array<{ node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
      if (!e.hadRecentInput) void (window as unknown as { recordQaShift: (v: number, t: number, sources: unknown) => void }).recordQaShift(e.value, e.startTime, e.sources.map(source => ({ node: source.node?.outerHTML?.slice(0, 250), previous: source.previousRect, current: source.currentRect })));
    } }).observe({ type: "layout-shift", buffered: true });
  });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/en/app?persona=qa-history");
  const field = page.locator("[data-conversation-field]");
  await expect(field.getByText("HISTORY-CURRENT-TURN-7", { exact: false })).toHaveCount(1);
  await expect(field.getByText("HISTORY-PREVIOUS-TURN-0", { exact: false })).toHaveCount(1);
  await expect(field.getByText("HISTORY-OLDER-TURN-0", { exact: false })).toHaveCount(0);
  const keys = await field.locator("[data-key]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-key")));
  expect(keys.length).toBeGreaterThanOrEqual(44);
  expect(new Set(keys).size).toBe(keys.length);
  await page.screenshot({ path: info.outputPath("cold-initial.png") });
  await field.evaluate(el => { const state = window as unknown as { qaNodes: Element[]; qaUnmounts: number }; state.qaNodes = Array.from(el.querySelectorAll("[data-key]")); state.qaUnmounts = 0; new MutationObserver(records => { for (const record of records) for (const removed of record.removedNodes) if (state.qaNodes.some(node => removed === node || (removed instanceof Element && removed.contains(node)))) state.qaUnmounts++; }).observe(el, { childList: true, subtree: true }); });
  await page.waitForTimeout(1000);
  const coldShifts = [...shifts];
  const coldTotal = coldShifts.reduce((total, shift) => total + shift.value, 0);
  await info.attach("layout-shifts", { body: JSON.stringify({ coldShifts, coldTotal }, null, 2), contentType: "application/json" });
  await field.hover();
  for (let i = 0; i < 12 && await field.evaluate(el => el.scrollTop) > 0; i++) { await page.mouse.wheel(0, -1800); await page.waitForTimeout(80); }
  await expect.poll(() => field.evaluate(el => el.scrollTop)).toBeLessThan(100);
  expect(await field.locator("[data-key]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-key")))).toEqual(keys);
  await page.screenshot({ path: info.outputPath("scrolled-top.png") });
  await field.focus();
  await page.keyboard.press("End");
  await expect.poll(() => field.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await field.locator("[data-key]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-key")))).toEqual(keys);
  expect(await field.evaluate(el => { const previous = (window as unknown as { qaNodes: Element[] }).qaNodes; const current = Array.from(el.querySelectorAll("[data-key]")); return previous.length === current.length && previous.every((node, i) => node.isConnected && node === current[i]); })).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { qaUnmounts: number }).qaUnmounts)).toBe(0);

  await info.attach("browser-errors", { body: JSON.stringify(errors), contentType: "application/json" });
  expect(errors).toEqual([]);
  const entrance = page.locator(".workspace-history-entrance button");
  await expect(entrance).toBeVisible();
  await entrance.click();
  await expect(page.getByText("HISTORY-OLDER", { exact: false }).first()).toBeVisible();
  expect(coldTotal, "Cold-load cumulative layout shift before input").toBeLessThan(0.1);
});
