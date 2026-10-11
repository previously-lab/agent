/**
 * probe-v029-records.mjs — the DOM proof for the v0.29 records section in
 * the library panel: the reader's conversations are listed in the panel,
 * the row count matches what the archive field knows, and clicking a row
 * opens that transcript on the desk (masthead clock matches the slice id).
 * Read-only against the reader's real memory: opens the panel, opens a
 * document — never touches the composer.
 *
 *   node scripts/probe-v029-records.mjs [width]   # default 1440
 */
import { chromium } from "playwright";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const WIDTH = Number(process.argv[2] ?? 1440);
const HEIGHT = WIDTH < 640 ? 844 : 900;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("response", (r) => r.status() === 404 && errors.push(`404: ${r.url()}`));

await page.emulateMedia({ colorScheme: "light" });
await page.goto(`${BASE}/en/app`, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(2500);

// The archive field's own knowledge: the record piles' aria-labels are
// "… — N conversations, M turns" — summed, that is the truth to match.
const field = await page.evaluate(() => {
  const labels = [...document.querySelectorAll("[aria-label]")]
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((l) => / — \d+ conversation/.test(l));
  const parsed = labels.map((l) => {
    const m = l.match(/ — (\d+) conversation.* (\d+) turn/);
    return m ? { slices: Number(m[1]), turns: Number(m[2]), label: l } : null;
  }).filter(Boolean);
  return {
    piles: parsed.length,
    slices: parsed.reduce((s, p) => s + p.slices, 0),
    turns: parsed.reduce((s, p) => s + p.turns, 0),
    sample: parsed.slice(0, 3).map((p) => p.label),
  };
});
console.log(`[${WIDTH}] field record piles:`, JSON.stringify(field));

// Open the library panel and read the records section.
await page.click("[data-library-toggle]");
await page.waitForSelector("[data-records]", { timeout: 15_000 });
await page.waitForTimeout(600);

const panel = await page.evaluate(() => {
  const panelEl = document.querySelector("[data-library-panel]");
  const pr = panelEl?.getBoundingClientRect();
  const buckets = [...document.querySelectorAll("[data-records-bucket]")].map((d) => ({
    key: d.getAttribute("data-records-bucket"),
    label: d.querySelector("p")?.textContent ?? "",
    rows: d.querySelectorAll("[data-records-row]").length,
  }));
  const rows = [...document.querySelectorAll("[data-records-row]")].map((b) => {
    const r = b.getBoundingClientRect();
    const spans = b.querySelectorAll("span");
    return {
      sliceId: b.getAttribute("data-records-row"),
      clock: spans[0]?.textContent ?? "",
      turns: spans[1]?.textContent ?? "",
      h: Math.round(r.height),
      overflows: pr ? r.right > pr.right + 0.5 || r.left < pr.left - 0.5 : null,
    };
  });
  const heading = document.querySelector("[data-records] h3")?.textContent;
  return {
    heading,
    panelWidth: pr ? Math.round(pr.width) : null,
    buckets,
    rows,
    anyOverflow: rows.some((r) => r.overflows),
  };
});
console.log(`[${WIDTH}] panel heading: "${panel.heading}"`);
console.log(`[${WIDTH}] buckets:`, JSON.stringify(panel.buckets));
console.log(`[${WIDTH}] rows: ${panel.rows.length}, field slices: ${field.slices}, match: ${panel.rows.length === field.slices}`);
console.log(`[${WIDTH}] row heights (tap targets):`, [...new Set(panel.rows.map((r) => r.h))].join(","));
console.log(`[${WIDTH}] any row overflows panel: ${panel.anyOverflow}`);
console.log(`[${WIDTH}] first rows:`, JSON.stringify(panel.rows.slice(0, 4)));

// Click the newest row — the transcript lands on the desk, and the
// masthead's clock is the slice id's own HH:MM.
if (panel.rows.length > 0) {
  const target = panel.rows[0].sliceId;
  const expectedClock = `${target.slice(11, 13)}:${target.slice(13, 15)}`;
  await page.click(`[data-records-row="${target}"]`);
  await page.waitForTimeout(1500);
  const desk = await page.evaluate(() => ({
    time: document.querySelector(".desk-masthead-time")?.textContent ?? "",
    cat: document.querySelector(".desk-masthead-cat")?.textContent ?? "",
    line: document.querySelector(".desk-masthead-line")?.textContent ?? "",
  }));
  const active = await page.evaluate((id) => {
    const b = document.querySelector(`[data-records-row="${id}"]`);
    return b ? b.className.includes("bg-muted") : null;
  }, target);
  console.log(`[${WIDTH}] opened ${target}: masthead time="${desk.time}" (expected ${expectedClock}), cat="${desk.cat}", line="${desk.line}"`);
  console.log(`[${WIDTH}] clock printed: ${desk.time.includes(expectedClock)}, row stays highlighted: ${active}`);
  await page.screenshot({ path: `shots/v029-records/records-open-${WIDTH}.png` });

  // Second row of the same bucket (if any) — a different transcript opens.
  if (panel.rows.length > 1) {
    const second = panel.rows[1].sliceId;
    // Below lg a selection closes the panel (the library's R1-A rule) —
    // reopen only when the section is actually gone.
    if (!(await page.$("[data-records]"))) {
      await page.click("[data-library-toggle]");
      await page.waitForSelector("[data-records]", { timeout: 10_000 });
      await page.waitForTimeout(400);
    }
    const visible = await page.$(`[data-records-row="${second}"]`);
    if (visible) {
      const exp2 = `${second.slice(11, 13)}:${second.slice(13, 15)}`;
      await page.click(`[data-records-row="${second}"]`);
      await page.waitForTimeout(1500);
      const t2 = await page.evaluate(() => document.querySelector(".desk-masthead-time")?.textContent ?? "");
      const line2 = await page.evaluate(() => document.querySelector(".desk-masthead-line")?.textContent ?? "");
      console.log(`[${WIDTH}] opened ${second}: masthead time="${t2}", line="${line2}", clock printed: ${t2.includes(exp2)}`);
    }
  }
}

console.log(`[${WIDTH}] console errors:`, errors.length ? errors.slice(0, 5) : "none");
await browser.close();
