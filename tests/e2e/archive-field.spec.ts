import { test, expect, type Page } from "@playwright/test";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
  type FixtureCase,
} from "./memory-fixture";

/**
 * Archive-field e2e (v0.25a §四): the 原稿 rung's default surface is the
 * field of piles — rows are time buckets, columns the case categories, a
 * cell one pile (one case: its index + its pieces). Covered here: the piles
 * render with their thickness tiers, a pile opens its case on the desk,
 * Escape returns to the field at the SAME scroll position (the rig is
 * shell-held), and a phone viewport lays the field flat into one column.
 *
 * Cases are seeded straight into the isolated MEMORY_ROOT
 * (memory/<category>/<case>/index.md + dated pieces — see memory-fixture.ts);
 * one historical slice keeps the arrival gate at the pill so the field is
 * never covered by a risen panel. No chat turn ever runs.
 *
 * NOTE the field VIRTUALIZES (visibleRangeFor): only rows near the scroll
 * window mount, so a spec never counts piles globally — it asserts the
 * piles that the current scroll position should show, then scrolls.
 */

const DAY = 24 * 3600_000;

/** A `YYYY-MM-DD` in LOCAL days before today — the model buckets by the
 *  reader's local calendar, so the fixtures must speak the same frame. */
function localIso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `n` pieces all born on `date` — the pile's volume is 1 + n. */
function piecesOn(date: string, n: number): FixtureCase["pieces"] {
  return Array.from({ length: n }, (_, i) => ({ date, title: `p${i + 1}` }));
}

/**
 * Eight cases across five categories: seven day buckets (today … today-6,
 * safely inside the trailing-week rule) plus one week bucket (today-20).
 * Volumes exercise every tier: 1 page → thin (3 sheets), 5 → medium (6),
 * 12 → thick (the 10-sheet cap). Desktop total ≈ header + 8 rows ≈ 2100px —
 * the field genuinely scrolls at the 1280×720 default viewport.
 */
function fieldCases(): FixtureCase[] {
  return [
    { category: "people", name: "field-alpha", opened: localIso(0), pieces: [] },
    { category: "people", name: "field-beta", opened: localIso(1), pieces: piecesOn(localIso(1), 2) },
    { category: "events", name: "field-gamma", opened: localIso(2), pieces: piecesOn(localIso(2), 4) },
    { category: "events", name: "field-delta", opened: localIso(3), pieces: [] },
    { category: "things", name: "field-epsilon", opened: localIso(4), pieces: piecesOn(localIso(4), 6) },
    { category: "research", name: "field-zeta", opened: localIso(5), pieces: [] },
    { category: "research", name: "field-eta", opened: localIso(6), pieces: piecesOn(localIso(6), 3) },
    { category: "orgs", name: "field-theta", opened: localIso(20), pieces: piecesOn(localIso(20), 11) },
  ];
}

function pile(page: Page, ref: string) {
  return page.locator(`[data-archive-pile="${ref}"]`);
}

/** Seed the world and land on the reader rung with the field settled: the
 *  first pile visible is the post-hydration, post-fetch, post-compile
 *  signal (the first canvas mount compiles the three.js chunk in dev). */
async function openField(page: Page): Promise<void> {
  await seedSlices([makeSlice(new Date(Date.UTC(2026, 1, 1, 9)).toISOString(), { tag: "OLD" })]);
  await seedCases(fieldCases());
  await page.goto("/en/app");
  await expect(pile(page, "people/field-alpha")).toBeVisible({ timeout: 30_000 });
}

/** Wait until `ref`'s pile holds still: two probe reads 400ms apart within
 *  a pixel (the rig's exponential ease snaps under 0.05px residual, so a
 *  quiet 400ms window means settled — robust to slow headless frame rates). */
async function waitSettled(page: Page, ref: string): Promise<void> {
  const target = pile(page, ref);
  let lastY = -1;
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(400);
        const y = (await target.boundingBox())?.y ?? -1;
        const stable = lastY >= 0 && y >= 0 && Math.abs(y - lastY) < 1;
        lastY = y;
        return stable ? 1 : 0;
      },
      { timeout: 20_000 },
    )
    .toBe(1);
}

test.describe("Archive field", () => {
  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
  });

  test("renders the piles tiered by volume, under the category header; the past mounts on scroll", async ({
    page,
  }) => {
    await openField(page);

    // The first screenful of rows (virtualization: deeper rows mount on
    // scroll — asserting a global count would test the scroller, not the
    // data).
    await expect(pile(page, "people/field-beta")).toBeVisible();
    await expect(pile(page, "events/field-gamma")).toBeVisible();
    await expect(pile(page, "events/field-delta")).toBeVisible();

    // The thickness tiers (archive-model.ts's one table): thin renders 3
    // sheets, medium 6.
    await expect(
      pile(page, "people/field-alpha").locator(".archive-sheet"),
    ).toHaveCount(3);
    await expect(
      pile(page, "events/field-gamma").locator(".archive-sheet"),
    ).toHaveCount(6);

    // The desktop header row names the present categories only — a category
    // with no case has no column. (en `library.category.orgs` → "Organizations")
    const header = page.locator(".archive-header");
    await expect(header.getByText("People", { exact: true })).toBeVisible();
    await expect(header.getByText("Organizations", { exact: true })).toBeVisible();
    await expect(header.getByText("Places", { exact: true })).toHaveCount(0);

    // The far past mounts on scroll: the week bucket's pile renders thick —
    // the 10-sheet cap for a 12-page case.
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 4000);
    const theta = pile(page, "orgs/field-theta");
    await expect(theta).toBeVisible({ timeout: 15_000 });
    await expect(theta.locator(".archive-sheet")).toHaveCount(10);
  });

  test("opens the pile's case on the desk; Escape puts it back", async ({
    page,
  }) => {
    await openField(page);
    await waitSettled(page, "people/field-alpha");

    await pile(page, "people/field-alpha").click();
    // The desk's stack is the open document's seat; the case's own index
    // text proves the right document arrived.
    await expect(page.locator("[data-desk-stack]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("Case field-alpha — the seeded index.").first(),
    ).toBeVisible({ timeout: 30_000 });
    // Handover: the field is gone while the desk stands.
    await expect(page.locator("[data-archive-pile]")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(pile(page, "people/field-alpha")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("[data-desk-stack]")).toHaveCount(0);
  });

  test("returns to the same scroll position after a desk round trip", async ({
    page,
  }) => {
    await openField(page);

    // Scroll into the past until the week bucket's pile is on screen. The
    // wheel handler is window-bound and chrome-gated; mid-viewport is field.
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 1600);
    const theta = pile(page, "orgs/field-theta");
    await expect(theta).toBeVisible({ timeout: 15_000 });
    await waitSettled(page, "orgs/field-theta");
    const before = (await theta.boundingBox())!;

    await theta.click();
    await expect(page.locator("[data-desk-stack]")).toBeVisible({
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");
    await expect(theta).toBeVisible({ timeout: 15_000 });

    // The rig is shell-held: the remounted field returns to the exact
    // scroll the reader left (a warm remount skips the entrance stagger).
    await expect
      .poll(
        async () => {
          const b = await theta.boundingBox();
          return b ? Math.abs(b.y - before.y) : 99;
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(4);
  });

  test("a phone viewport lays the field flat: one pile per screen, one column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openField(page);

    // No desktop header row; the buckets carry their own label units.
    await expect(page.locator(".archive-header")).toHaveCount(0);

    const alpha = pile(page, "people/field-alpha");
    const beta = pile(page, "people/field-beta");
    await expect(beta).toBeVisible({ timeout: 10_000 });
    const a = (await alpha.boundingBox())!;
    const b = (await beta.boundingBox())!;
    // Same column: the centres align; one pile per screen: stacked vertically.
    expect(Math.abs(a.x + a.width / 2 - (b.x + b.width / 2))).toBeLessThan(2);
    expect(b.y).toBeGreaterThan(a.y + a.height / 2);
  });
});
