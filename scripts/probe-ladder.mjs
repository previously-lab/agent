/**
 * Ladder probe — drives the rung ladder and the composer's two forms.
 *
 * This covers the two things that are easiest to get wrong and hardest to
 * notice:
 *
 *   1. THE COLLAPSED COMPOSER MUST BE CLICKABLE. It sits above a WebGL canvas
 *      whose cards pin their own portals at z-index 21-30, and the pane it
 *      belongs to used to be dimmed to `opacity-30 pointer-events-none` as a
 *      whole — which took the composer with it. `page.click()` runs
 *      Playwright's actionability checks, which include "receives pointer
 *      events", so a click that lands is the assertion.
 *   2. THE CONVERSATION FIELD MUST SURVIVE A RUNG CHANGE. It is the same DOM
 *      node before and after, because the stream and the camera live in it.
 *
 * Usage: node scripts/probe-ladder.mjs [--base http://localhost:3000]
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const baseArg = process.argv.indexOf("--base");
const base = baseArg >= 0 ? process.argv[baseArg + 1] : BASE;

const browser = await chromium.launch({ headless: true });
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const lens = page.getByRole("group", { name: "Lens" });
  const seg = (r) => lens.getByRole("button", { name: r });

  await page.goto(`${base}/en`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6000);

  // ── The conversation rung is where `/` opens ─────────────────────────────
  check(
    "`/` opens on the conversation rung",
    (await seg("Conversation").getAttribute("aria-pressed")) === "true",
  );
  check(
    "the full composer is up at the conversation rung",
    await page.locator("textarea").first().isVisible(),
  );
  check(
    "no collapsed button at the conversation rung",
    (await page.locator("[data-composer-collapsed]").count()) === 0,
  );

  const fieldBefore = await page.evaluate(
    () => document.querySelector("[data-conversation-field]") !== null,
  );
  check("the conversation field is mounted", fieldBefore);

  // ── Zoom out to a card rung via the lens ─────────────────────────────────
  await seg("Slice").click();
  await page.waitForTimeout(2500);

  check(
    "the URL carries the rung",
    /z=slice/.test(page.url()),
    page.url().replace(base, ""),
  );
  check(
    "the slice segment is active",
    (await seg("Slice").getAttribute("aria-pressed")) === "true",
  );
  check(
    "the card field rendered",
    (await page.locator(".tl-card-in").count()) > 0,
    `${await page.locator(".tl-card-in").count()} cards`,
  );

  // ── The collapsed composer: present, and CLICKABLE ───────────────────────
  const fab = page.locator("[data-composer-collapsed]");
  check("the collapsed composer is present", (await fab.count()) === 1);
  check("the collapsed composer is visible", await fab.isVisible());

  // WHAT THE COLLAPSED FORM CARRIES, which is a design decision and not an
  // accident of markup. The docs button is in BOTH forms (reading the memory
  // is not a conversation act); the attach button is in the full form only
  // (choosing a file is the first half of sending, and there is no send button
  // on screen); the model picker is in the full form only (it configures the
  // next message, and there is no next message to write yet).
  const pill = page.locator("[data-composer-pill]");
  check("the compact composer is a pill of controls", (await pill.count()) === 1);
  check(
    "the compact pill carries the memory-docs button",
    (await pill.getByRole("button", { name: /docs|文档/i }).count()) === 1,
  );
  // By hook, not by name: the attach control's label changes with the selected
  // model's vision capability ("Attach files" vs "This model can't read
  // images"), so a name-based probe would pass for the wrong reason on one
  // model and fail on the other.
  check(
    "the compact pill carries NO attach button",
    (await pill.locator("[data-attach]").count()) === 0,
  );
  check(
    "the compact pill carries no model picker",
    (await pill.getByText(/V4|Pro|Flash/i).count()) === 0,
  );

  // `click()` includes the "receives pointer events" actionability check, so a
  // covering element fails here rather than silently swallowing the press.
  let clicked = false;
  let clickErr = "";
  try {
    await fab.click({ timeout: 5000 });
    clicked = true;
  } catch (e) {
    clickErr = e.message.split("\n")[0];
  }
  check("the collapsed composer is CLICKABLE", clicked, clickErr);

  if (clicked) {
    await page.waitForTimeout(700);
    const area = page.locator("textarea").first();
    check("clicking it opens the full composer", await area.isVisible());
    // The two forms differ by MORE than size, and this is the half of that
    // difference a screenshot cannot prove: the attach button is back.
    const expanded = page.locator("[data-composer]");
    const attach = expanded.locator("[data-attach]");
    check("the full form restores the attach button", (await attach.count()) === 1);
    // ...and it is REACHABLE, not just present: an icon-only control with no
    // accessible name is a control a screen reader cannot announce.
    const attachName = (await attach.getAttribute("aria-label")) ?? "";
    check("the attach button has an accessible name", attachName.length > 0, attachName);
    // Editable, not just visible: a textarea under `inert` renders and refuses
    // every keystroke, which would look identical in a screenshot.
    await area.click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.type("hello");
    const value = await area.inputValue().catch(() => "");
    check("the opened composer accepts typing", value === "hello", `value="${value}"`);
  }

  // ── Back to the conversation ─────────────────────────────────────────────
  await seg("Conversation").click();
  await page.waitForTimeout(1800);
  check(
    "the rung param is dropped for the default rung",
    !/z=/.test(page.url()),
    page.url().replace(base, ""),
  );
  const fieldAfter = await page.evaluate(
    () => document.querySelector("[data-conversation-field]") !== null,
  );
  check("the conversation field survived the round trip", fieldAfter);

  // ── The rail carries the map; the right edge carries the controls ────────
  // These two are here because they were MOVED, and a stale dev server serving
  // the old bundle passes every behavioural check above while failing these —
  // which is exactly how a false PASS happened earlier in this project.
  const jumpTop = page.locator('[data-jump="top"]');
  check("the jump-to-oldest control exists", (await jumpTop.count()) === 1);
  if (await jumpTop.count()) {
    const jb = await jumpTop.boundingBox();
    const rail = await page.locator("[data-scrub-surface]").boundingBox();
    check(
      "the jump controls float to the RIGHT of the rail, not on it",
      !!jb && !!rail && jb.x > rail.x + rail.width,
      jb && rail
        ? `jump x=${Math.round(jb.x)}, rail ends ${Math.round(rail.x + rail.width)}`
        : "missing box",
    );
  }
  check(
    "the NOW caption is gone",
    (await page.getByText(/NOW\s*·/).count()) === 0,
  );

  // ── The three bars, and what each one is allowed to say ──────────────────
  // The board bar is at the top CENTRE and carries both field controls: the
  // zoom lens and the strand selector, which used to live on the 24-32px time
  // rail. The settings bar is at the top right and carries no words.
  const board = page.locator("[data-board-bar]");
  check("the board bar exists", (await board.count()) === 1);
  check(
    "the board bar carries the zoom lens",
    (await board.getByRole("group", { name: "Lens" }).count()) === 1,
  );
  check(
    "the board bar carries the strand selector",
    (await board.getByRole("button", { name: /filter timeline/i }).count()) === 1,
  );
  check(
    "the strand selector left the time rail",
    (await page.locator("[data-scrub-surface]").getByRole("button", { name: /filter timeline/i }).count()) === 0,
  );
  // Only the ACTIVE segment spells itself out — four lit words would state the
  // destinations and not the position.
  const lensLabels = await board
    .getByRole("group", { name: "Lens" })
    .locator("button span")
    .count();
  check("exactly one lens segment shows its name", lensLabels === 1, `${lensLabels} labels`);

  // ── The three bars are ONE bar, three times ──────────────────────────────
  // The reader's complaint was that they looked different, and they did: same
  // material, three heights, because each sized itself to its own contents.
  // `ISLAND_BAR` pins the height instead. Measured rather than eyeballed,
  // because "they look the same now" is how they drifted apart the first time.
  const bars = await page.evaluate(() => {
    const out = [];
    const header = document.querySelector("header");
    if (header) {
      for (const el of header.children) {
        const r = el.getBoundingClientRect();
        if (r.height > 0) out.push({ name: "header", h: Math.round(r.height) });
      }
    }
    const board = document.querySelector("[data-board-bar] > *");
    if (board) out.push({ name: "board", h: Math.round(board.getBoundingClientRect().height) });
    return out;
  });
  const heights = [...new Set(bars.map((b) => b.h))];
  check(
    "all three top bars are the same height",
    bars.length >= 3 && heights.length === 1,
    bars.map((b) => `${b.name}=${b.h}`).join(" "),
  );

  // The settings bar: every control is a glyph. It is the LAST island in the
  // header, and its text labels were the widest thing in the chrome.
  const settingsBar = page.locator("header nav");
  check(
    "the settings bar shows no text labels",
    (await settingsBar.locator("span:not(.sr-only)").count()) === 0,
  );

  await ctx.close();

  // ── The bottom-of-screen controls must not overlap, at PHONE width ───────
  // Two fixed controls, one centred and one right-anchored, both counting from
  // the bottom. At 390px they collided in a corner — the composer's button and
  // the lens's left edge occupied the same pixels — and nothing else in the
  // suite would have noticed, because every other check asks about ONE element.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const pp = await phone.newPage();
  await pp.goto(`${base}/en?z=slice`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await pp.waitForTimeout(6500);

  // ── The PHONE arrangement: brand and board bar share the first line, and
  //    the settings wrap below them, right-aligned. ────────────────────────
  const phoneBars = await pp.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { y: Math.round(b.y), right: Math.round(b.right), left: Math.round(b.left) };
    };
    const header = document.querySelector("header");
    const kids = header ? [...header.children].filter((e) => e.getBoundingClientRect().height > 0) : [];
    return {
      brand: kids[0] ? r(kids[0]) : null,
      settings: kids[kids.length - 1] ? r(kids[kids.length - 1]) : null,
      board: document.querySelector("[data-board-bar] > *")
        ? r(document.querySelector("[data-board-bar] > *"))
        : null,
    };
  });
  const { brand, settings, board: boardP } = phoneBars;
  check(
    "phone: the brand and the board bar share the first line",
    !!brand && !!boardP && Math.abs(brand.y - boardP.y) < 6,
    brand && boardP ? `brand y=${brand.y}, board y=${boardP.y}` : "missing",
  );
  check(
    "phone: the settings bar wraps to the line below",
    !!settings && !!brand && settings.y > brand.y + 10,
    settings && brand ? `settings y=${settings.y}, brand y=${brand.y}` : "missing",
  );
  check(
    "phone: the brand and the board bar do NOT overlap",
    !!brand && !!boardP && brand.right + 4 <= boardP.left,
    brand && boardP ? `brand ends ${brand.right}, board starts ${boardP.left}` : "missing",
  );

  const fb = await pp.locator("[data-composer-collapsed]").boundingBox();
  const lb = await pp.getByRole("group", { name: "Lens" }).boundingBox();

  check("the collapsed composer is present at phone width", !!fb);
  check("the lens is present at phone width", !!lb);

  if (fb && lb) {
    const overlaps =
      fb.x < lb.x + lb.width &&
      lb.x < fb.x + fb.width &&
      fb.y < lb.y + lb.height &&
      lb.y < fb.y + fb.height;
    check(
      "the collapsed composer does NOT overlap the lens",
      !overlaps,
      overlaps
        ? `composer ${Math.round(fb.x)}..${Math.round(fb.x + fb.width)} x ${Math.round(fb.y)}..${Math.round(fb.y + fb.height)} vs lens ${Math.round(lb.x)}..${Math.round(lb.x + lb.width)} x ${Math.round(lb.y)}..${Math.round(lb.y + lb.height)}`
        : `composer y ${Math.round(fb.y)}..${Math.round(fb.y + fb.height)}, lens y ${Math.round(lb.y)}..${Math.round(lb.y + lb.height)}`,
    );
    check(
      "the collapsed composer sits inside the phone viewport",
      fb.x >= 0 && fb.x + fb.width <= 390,
      `x=${Math.round(fb.x)}..${Math.round(fb.x + fb.width)} of 390`,
    );
  }
  await phone.close();
} finally {
  await browser.close();
}

console.log(
  failures === 0 ? "\nThe ladder works." : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
