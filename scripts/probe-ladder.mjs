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
