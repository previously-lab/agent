import { test, expect, type Page } from "@playwright/test";
import {
  clearCases,
  clearDossier,
  clearEpisodic,
  dossierSentinel,
  makeSlice,
  seedCases,
  seedDossier,
  seedSlices,
} from "./memory-fixture";

/**
 * Records-as-papers + Dossier + desk memory e2e (v0.25b §三, v0.25 §3.4/§4):
 *
 * RECORDS — every time bucket in the archive field carries ONE record pile
 * (its thickness tiers off the bucket's turn volume); opening it reads the
 * bucket's NEWEST slice as a verbatim transcript on the A4 desk — speaker
 * labels over the turns, the slice id top-left, the turn count in the
 * footer. DOSSIER — the two self-documents (current-previously / direction)
 * pin to the top of the library and open on the same desk under
 * `dossier/<name>`. DESK MEMORY — the reader reopens on the last document
 * he had open (localStorage), a dead remembered ref falling back to the
 * field without blocking. Plus the pointer-events regression: the desk pane
 * must let hits reach the paper (the archive field's portal pattern).
 *
 * All data is seeded straight into the isolated MEMORY_ROOT (see
 * memory-fixture.ts); slices are closed and days old so the arrival gate
 * stays at the pill. No chat turn ever runs.
 */

const DAY = 24 * 3600_000;

/** The desk-memory key — mirrors LAST_DOCUMENT_KEY in shell-provider.tsx
 *  (e2e files never import from src). */
const LAST_DOCUMENT_KEY = "previously:last-document:v1";

/** A UTC ISO `daysAgo` back — closed, days old: the arrival gate stays calm. */
function daysAgoIso(daysAgo: number, hour = 9): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour),
  ).toISOString();
}

function recordPiles(page: Page) {
  return page.locator("[data-record-pile]");
}

/** Seed two record buckets (two slices on day-1, one on day-2) plus one case
 *  (a records-only field has a single column, which lays out flat with no
 *  header unit — the header assertion needs the mixed grid), and land on the
 *  field with both record piles mounted. */
async function openRecordField(page: Page): Promise<{ newestA: string }> {
  const a1 = makeSlice(daysAgoIso(1, 9), { tag: "RA1" });
  const a2 = makeSlice(daysAgoIso(1, 14), { tag: "RA2" });
  const b1 = makeSlice(daysAgoIso(2, 10), { tag: "RB1" });
  await seedSlices([a1, a2, b1]);
  await seedCases([
    {
      category: "research",
      name: "records-coexist",
      opened: daysAgoIso(0).slice(0, 10),
      pieces: [],
    },
  ]);
  await page.goto("/en/app");
  await expect(recordPiles(page)).toHaveCount(2, { timeout: 30_000 });
  return { newestA: a2.id };
}

test.describe("Records are papers", () => {
  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
    await clearDossier();
  });

  test("every bucket's record pile tiers off its turns and opens the newest slice's transcript", async ({
    page,
  }) => {
    const { newestA } = await openRecordField(page);

    // The synthetic trailing column exists while records do.
    await expect(
      page.locator(".archive-header").getByText("Records", { exact: true }),
    ).toBeVisible();

    // Thickness follows the bucket's TURN volume: day-1 holds 2 slices × 2
    // turns = 4 → medium (6 sheets); day-2 holds 2 turns → thin (3).
    const pileA = page.locator(`[data-archive-pile="records/${newestA}"]`);
    await expect(pileA.locator(".archive-sheet")).toHaveCount(6);
    await expect(
      recordPiles(page).nth(1).locator(".archive-sheet"),
    ).toHaveCount(3);

    await pileA.click();
    await expect(page.locator("[data-desk-stack]")).toBeVisible({
      timeout: 30_000,
    });
    // The transcript is the NEWEST slice's, verbatim, speaker labels on.
    await expect(
      page.getByText("TURN RA2 user question", { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("TURN RA2 agent answer", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.locator(".desk-flow").getByText("You", { exact: true }).first(),
    ).toBeVisible();
    // The header carries the slice id, the footer the turn count.
    await expect(page.locator(".desk-head").first()).toContainText(newestA);
    await expect(page.locator(".desk-foot").first()).toContainText("2 turns");
  });

  test("the Dossier pins atop the library and opens on the desk", async ({
    page,
  }) => {
    await seedSlices([makeSlice(daysAgoIso(40), { tag: "OLD" })]);
    await seedDossier();
    await page.goto("/en/app");
    await page.locator("[data-library-toggle]").click();

    const dossier = page.locator("[data-dossier]");
    await expect(dossier).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-dossier-doc="previously"]')).toBeEnabled();
    await expect(page.locator('[data-dossier-doc="direction"]')).toBeEnabled();

    await page.locator('[data-dossier-doc="previously"]').click();
    await expect(page.locator("[data-desk-stack]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(dossierSentinel("previously")).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("with no Dossier documents on disk the section hides", async ({
    page,
  }) => {
    await seedSlices([makeSlice(daysAgoIso(40), { tag: "OLD" })]);
    await page.goto("/en/app");
    await page.locator("[data-library-toggle]").click();
    await expect(
      page.locator("[data-library-panel]"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-dossier]")).toHaveCount(0);
  });

  test("the desk reopens on the last document after a reload", async ({
    page,
  }) => {
    await seedSlices([makeSlice(daysAgoIso(40), { tag: "OLD" })]);
    await seedCases([
      { category: "research", name: "remember-me", opened: daysAgoIso(1).slice(0, 10), pieces: [] },
    ]);
    await page.goto("/en/app");
    const pile = page.locator('[data-archive-pile="research/remember-me"]');
    await expect(pile).toBeVisible({ timeout: 30_000 });
    await pile.click();
    await expect(
      page.getByText("Case remember-me — the seeded index.").first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.reload();
    // No click this time — the desk's own memory reopens the document.
    await expect(page.locator("[data-desk-stack]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("Case remember-me — the seeded index.").first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("a dead remembered ref falls back to the field and clears the key", async ({
    page,
  }) => {
    await page.addInitScript(
      ([key]) => window.localStorage.setItem(key, "records/2020-01-01-0000"),
      [LAST_DOCUMENT_KEY],
    );
    await openRecordField(page);

    // The field stands, no desk ever mounts, the bad key is swept.
    await expect(recordPiles(page).first()).toBeVisible();
    await expect(page.locator("[data-desk-stack]")).toHaveCount(0);
    await expect
      .poll(
        () =>
          page.evaluate(
            ([key]) => window.localStorage.getItem(key),
            [LAST_DOCUMENT_KEY],
          ),
        { timeout: 10_000 },
      )
      .toBeNull();
  });

  test("the paper takes the hit: elementFromPoint lands in the stack and text selects", async ({
    page,
  }) => {
    await seedSlices([makeSlice(daysAgoIso(40), { tag: "OLD" })]);
    await seedCases([
      { category: "research", name: "pointer-case", opened: daysAgoIso(1).slice(0, 10), pieces: [] },
    ]);
    await page.goto("/en/app");
    const pile = page.locator('[data-archive-pile="research/pointer-case"]');
    await expect(pile).toBeVisible({ timeout: 30_000 });
    await pile.click();
    await expect(
      page.getByText("Case pointer-case — the seeded index.").first(),
    ).toBeVisible({ timeout: 30_000 });

    // The hit test: the paper's centre must resolve to the paper's own DOM,
    // not the desk pane's wrapper (the archive field's old failure shape).
    const hit = await page.evaluate(() => {
      const el = document.querySelector('[data-desk-shell="0"] .desk-paper');
      if (!(el instanceof HTMLElement)) return "no-paper";
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit && el.contains(hit) ? "paper" : (hit?.tagName ?? "nothing");
    });
    expect(hit).toBe("paper");

    // Text selection: a double-click on the body selects a word (the swipe
    // gesture only claims fast horizontal flicks, nothing preventDefaulted).
    await page.locator(".desk-flow p").first().dblclick();
    const selected = await page.evaluate(() =>
      window.getSelection()?.toString() ?? "",
    );
    expect(selected.length).toBeGreaterThan(0);
  });
});
