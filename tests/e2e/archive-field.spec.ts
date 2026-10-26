import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import {
  clearCases,
  clearEpisodic,
  makeSlice,
  seedCases,
  seedSlices,
  type FixtureCase,
  type FixtureSlice,
} from "./memory-fixture";

/** DOM document and record browser coverage. The retired 3D archive rig is
 * intentionally not treated as the acceptance contract for this workspace. */

const DAY = 24 * 3600_000;

function localIso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function piecesOn(date: string, n: number): FixtureCase["pieces"] {
  return Array.from({ length: n }, (_, i) => ({ date, title: `p${i + 1}` }));
}

function libraryCases(): FixtureCase[] {
  return [
    { category: "people", name: "field-alpha", opened: localIso(0), pieces: [] },
    { category: "people", name: "field-beta", opened: localIso(1), pieces: piecesOn(localIso(1), 2) },
    { category: "events", name: "field-gamma", opened: localIso(2), pieces: piecesOn(localIso(2), 4) },
    { category: "things", name: "field-epsilon", opened: localIso(4), pieces: piecesOn(localIso(4), 6) },
    { category: "research", name: "field-zeta", opened: localIso(5), pieces: [] },
    { category: "orgs", name: "field-theta", opened: localIso(20), pieces: piecesOn(localIso(20), 11) },
  ];
}

function historySlices(count: number): FixtureSlice[] {
  const base = Date.UTC(2026, 1, 1, 9, 0, 0);
  return Array.from({ length: count }, (_, index) =>
    makeSlice(new Date(base + index * DAY).toISOString(), {
      tag: `H${String(index).padStart(2, "0")}`,
    }),
  );
}

async function openLibrary(page: Page): Promise<void> {
  await seedSlices([makeSlice(new Date(Date.UTC(2026, 1, 1, 9)).toISOString(), { tag: "OLD" })]);
  await seedCases(libraryCases());
  await page.goto("/en/app?view=field");
  await expect(page.locator('[data-workspace-surface="library"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /^People/ })).toBeVisible({ timeout: 30_000 });
}

async function openCategory(page: Page, name: string): Promise<void> {
  const category = page.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(category).toBeVisible();
  if (await category.getAttribute("aria-expanded") !== "true") await category.click();
  await expect(category).toHaveAttribute("aria-expanded", "true");
}

test.describe("DOM document workspace", () => {
  test.afterEach(async () => {
    await clearCases();
    await clearEpisodic();
  });

  test("opens a case without WebGL and Escape returns to the expanded library category", async ({ page }) => {
    await openLibrary(page);
    await expect(page.locator("canvas")).toHaveCount(0);
    await openCategory(page, "People");
    await page.getByRole("button", { name: /field-alpha/ }).click();
    await expect(page.locator("[data-desk-stack]")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Case field-alpha — the seeded index.").first()).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("doc")).toBe("people/field-alpha");

    await page.keyboard.press("Escape");
    await expect(page.locator('[data-workspace-surface="library"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-desk-stack]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^People/ })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: /field-alpha/ })).toBeVisible();
  });

  test("pages older records only after an explicit request and opens the exact record", async ({ page }) => {
    const slices = historySlices(25);
    await seedSlices(slices);
    await page.goto("/en/app?view=field&history=1");
    const browser = page.locator(".workspace-history-browser");
    await expect(browser).toBeVisible();
    await expect(browser).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    await expect(page.locator(".workspace-record-list li")).toHaveCount(20);
    await expect(page.getByRole("button", { name: new RegExp(slices[24].id) })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(slices[0].id) })).toHaveCount(0);

    await page.locator(".workspace-history-pages button").click();
    await expect(browser).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    const oldest = page.getByRole("button", { name: new RegExp(slices[0].id) });
    await expect(oldest).toBeVisible();
    await oldest.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("doc")).toBe(`records/${slices[0].id}`);
    await expect(page.getByText("TURN H00 user question").first()).toBeVisible({ timeout: 30_000 });
  });

  test("keeps DOM categories and case rows usable without horizontal overflow on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLibrary(page);
    await expect(page.locator("canvas")).toHaveCount(0);
    const panel = page.locator(".workspace-browser-panel");
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await openCategory(page, "Research");
    const row = page.getByRole("button", { name: /field-zeta/ });
    await expect(row).toBeVisible();
    const bounds = await row.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  });
});
