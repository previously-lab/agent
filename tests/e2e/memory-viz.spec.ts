import { test, expect } from "./test";
import type { Page } from "@playwright/test";
import {
  clearEpisodic,
  makeSlice,
  seedSlices,
  type FixtureSlice,
} from "./memory-fixture";

/** Isolated history, search and scene/reading navigation regression tests. */

const DAY = 24 * 3600_000;

/** Sentinel turn text — rendered verbatim by HistoryTurn. */
function sentinel(slice: FixtureSlice, role: "user" | "agent"): string {
  return slice.turns.find((t) => t.role === role)!.content;
}

/**
 * The conversation list's ROOT — the DOM scroller that owns the position.
 *
 * `data-conversation-field` is the conversation's stable hook: e2e specs and
 * probes have always addressed the conversation through it (it named the
 * retired R3F field's root before; it now names the DOM list's scroller),
 * and a selector is stabler than a class list.
 */
function conversationField(page: Page) {
  return page.locator("[data-conversation-field]");
}

/**
 * Rise the floating panel to fullscreen — the pill's expand verb, then the
 * fullscreen tier's own control proves the rise landed. (`Exit full screen`
 * has TWO visible seats at the fullscreen tier — the panel's slim bar and the
 * composer toolbar's collapse — hence `.first()`.)
 */
async function risePanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Expand to full screen" }).click();
  await expect(
    page.getByRole("button", { name: "Exit full screen" }).first(),
  ).toBeVisible();
}

/**
 * Twelve historical slices, one per day from 2026-02-01, with a checkpoint
 * chain in the middle: S01 closed by time_cap, S02 continues it (capacity
 * close) — everything else closes on idle_gap (a genuine boundary). S07
 * carries the unique search keyword "zebra". All older than any idle gap, so
 * arrival is always the briefing unless a fresh slice is added.
 */
function datasetA(): FixtureSlice[] {
  const base = Date.UTC(2026, 1, 1, 9, 0, 0);
  const slices: FixtureSlice[] = [];
  for (let i = 0; i < 12; i++) {
    slices.push(
      makeSlice(new Date(base + i * DAY).toISOString(), {
        tag: `S${String(i).padStart(2, "0")}`,
      }),
    );
  }
  slices[1].closedBy = "time_cap";
  slices[2].continuesFrom = slices[1].id;
  slices[2].closedBy = "capacity";
  slices[7].focus = "Zebra quantum retrospective";
  slices[7].tags = ["zebra"];
  return slices;
}

/** The still-alive slice for the resume test: last turn <10 min ago. */
function freshSlice(): FixtureSlice {
  const startIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const slice = makeSlice(startIso, { tag: "FRESH" });
  slice.status = "active";
  delete slice.end;
  delete slice.closedBy;
  return slice;
}

test.describe("Memory and scene navigation", () => {
  // NOT serial. Every test here seeds its OWN slices and `afterEach` clears
  // them, so the tests are already independent — and the config's one worker
  // is what stops them racing the shared dev server. Serial mode bought
  // nothing and cost a lot: one failure SKIPPED every test after it, so a
  // single known-broken case hid five working ones. A failure should now be
  // exactly as loud as it is.

  test.afterEach(async () => {
    await clearEpisodic();
  });

  test.describe("arrival gate", () => {
    test("resumes the still-alive slice with a banner instead of the briefing", async ({
      page,
    }) => {
      const old = makeSlice(new Date(Date.UTC(2026, 1, 1, 9)).toISOString(), {
        tag: "OLD",
      });
      const fresh = freshSlice();
      await seedSlices([old, fresh]);

      await page.goto("/en/app");
      // The panel opens on the PILL everywhere — the restored turns are in
      // its folded body, so the rise comes first.
      await risePanel(page);
      // chat.resume.banner — the restored turns sit directly under it.
      const panel = page.locator("#conversation-panel");
      await expect(
        panel.getByText(/Continuing the conversation from/),
      ).toBeVisible();
      await expect(
        panel.getByText(sentinel(fresh, "user")),
      ).toBeVisible();
      await expect(
        panel.getByText(sentinel(fresh, "agent")),
      ).toBeVisible();
      // The empty briefing is the OTHER branch — it must not render here.
      await expect(
        page.getByText("PREVIOUSLY ON", { exact: true }),
      ).toHaveCount(0);
    });

    test("seats the briefing card in the stream with history above (Rev 2)", async ({
      page,
    }) => {
      const slices = [
        makeSlice(new Date(Date.UTC(2026, 1, 1, 9)).toISOString(), {
          tag: "OLD1",
        }),
        makeSlice(new Date(Date.UTC(2026, 1, 2, 9)).toISOString(), {
          tag: "OLD2",
        }),
      ];
      await seedSlices(slices);

      await page.goto("/en/app");
      // A briefing arrival over a NON-empty memory leaves the panel at the
      // pill — the world is the opening surface and the card waits inside
      // the risen panel. The pill's single-line input is what is on screen.
      await expect(
        page.getByRole("textbox", { name: "Send a message..." }),
      ).toBeVisible();
      await risePanel(page);
      // The card is a stream item now (`emptyBriefing.eyebrow`, rendered
      // verbatim) — scoped to the panel's list.
      const panel = page.locator("#conversation-panel");
      const cardEyebrow = panel.getByText("PREVIOUSLY ON", { exact: true });
      await expect(cardEyebrow).toBeVisible();
      await expect(
        page.getByText(/Continuing the conversation from/),
      ).toHaveCount(0);

      // "History above" is literal: the card seats BETWEEN the cold-open
      // history page and the live edge, so it renders below the historical
      // turns in the same list — not above them and not on a view of its own.
      const oldestTurn = panel.getByText(sentinel(slices[0], "user"));
      await expect(oldestTurn).toBeVisible();
      await expect(panel.getByText(sentinel(slices[0], "agent"))).toBeVisible();
      const cardBox = await cardEyebrow.boundingBox();
      const turnBox = await oldestTurn.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(turnBox).not.toBeNull();
      expect(cardBox!.y).toBeGreaterThan(turnBox!.y);
    });

    test("an empty memory rises the panel to the full briefing on its own", async ({
      page,
    }) => {
      await seedSlices([]);

      await page.goto("/en/app");
      // 首装仍落对话: with NOTHING in memory the arrival face is the
      // standalone full-screen briefing, so the panel rises itself (once) —
      // no expand click. The fullscreen tier's own control is the proof.
      await expect(
        page.getByRole("button", { name: "Exit full screen" }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("PREVIOUSLY ON", { exact: true }),
      ).toBeVisible();
    });

    test("the fullscreen tier renders the cold-open page and pages nothing older (P0)", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      await page.goto("/en/app");
      // The panel opens on the pill — the expand verb is the reader's way to
      // the fullscreen tier, and that tier must not be the blank surface the
      // v0.25 pass measured (1440×0, chrome-only innerText).
      await risePanel(page);

      // The fullscreen body's DOM list carries the cold-open page's turns —
      // the ten-slice window (S02..S11; S00/S01 are outside the page and
      // never load here).
      const panel = page.locator("#conversation-panel");
      const newest = slices[slices.length - 1];
      await expect(panel.getByText(sentinel(newest, "user"))).toBeVisible();
      await expect(panel.getByText(sentinel(newest, "agent"))).toBeVisible();

      // The tier scrolls: ten slices of two turns exceed the viewport.
      const scroller = panel.locator("[data-conversation-field]");
      await expect
        .poll(() =>
          scroller.evaluate(
            (el) => (el as HTMLElement).scrollHeight - (el as HTMLElement).clientHeight,
          ),
        )
        .toBeGreaterThan(0);

      // The window's head is reachable: scrolling to the top mounts the
      // oldest slice of the loaded page, and the slices outside it stay
      // unloaded — the panel pages NOTHING older; happened-time browsing
      // deeper than the cold-open page belongs to the archive dispatch.
      await scroller.evaluate((el) => {
        (el as HTMLElement).scrollTop = 0;
      });
      await expect(panel.getByText(sentinel(slices[2], "user"))).toBeVisible();
      await expect(panel.getByText(sentinel(slices[0], "user"))).toHaveCount(0);
    });
  });


  test.describe("search palette", () => {
    test("Cmd/Ctrl+K searches the catalog and rises the panel to the slice", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      await page.goto("/en/app");
      // Hydration gate: the global Ctrl+K listener attaches in a mount effect,
      // so a keypress fired before hydration is silently lost. The client
      // badge only renders after its mount-time fetch resolved — a reliable
      // post-hydration signal in this client-mode suite.
      await expect(
        page.locator("[data-game-manuscripts]"),
      ).toBeVisible();
      await page.keyboard.press("Control+k");
      const input = page.locator("[cmdk-input]");
      await expect(input).toBeVisible();
      await input.fill("zebra");

      const hit = page
        .locator("[cmdk-item]")
        .filter({ hasText: "Zebra quantum retrospective" });
      await expect(hit).toBeVisible();
      await hit.click();

      // The palette closes and the jump RISES the panel (the target lives in
      // the list, and the reader should land looking at it), plays the travel
      // clock, and lands on S07 (already inside the cold-open page, so the
      // clock is the only wait).
      await expect(page.locator("[cmdk-input]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Exit full screen" }).first(),
      ).toBeVisible();
      const panel = page.locator("#conversation-panel");
      await expect(
        panel.getByText(sentinel(slices[7], "user")),
      ).toBeVisible();
      await expect(
        panel.getByText(sentinel(slices[7], "agent")),
      ).toBeVisible();
    });
  });

  test.describe("scene and reading", () => {
    test("opens on the scene and resumes after browsing manuscripts", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());
      await page.goto("/en/app");
      await expect(page.locator('[data-app-world="game"]')).toBeVisible();
      await page.locator("[data-game-manuscripts]").click();
      await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
      await expect(page.locator("[data-library-toggle]")).toBeVisible();
      await page.locator("[data-scene-resume]").click();
      await expect(page.locator('[data-app-world="game"]')).toBeVisible();
      await expect(page.locator("[data-game-manuscripts]")).toBeVisible();
    });

    test("the same draft survives scene, reading and fullscreen writing", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());
      await page.goto("/en/app");
      await expect(page.locator("[data-game-manuscripts]")).toBeVisible();
      const input = page.getByRole("textbox", { name: "Send a message..." });
      await input.pressSequentially("still here");
      await page.locator("[data-game-manuscripts]").click();
      await expect(page.locator('[data-app-world="field"]')).toBeVisible();
      await expect(input).toHaveValue("still here");
      await page.locator("[data-scene-resume]").click();
      await expect(page.locator('[data-app-world="game"]')).toBeVisible();
      await expect(input).toHaveValue("still here");
      await risePanel(page);
      await expect(page.locator("textarea").first()).toHaveValue("still here");
    });

    test("Ctrl+. toggles reading and scene without changing the URL", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());
      await page.goto("/en/app");
      await expect(page.locator("[data-game-manuscripts]")).toBeVisible();
      await page.keyboard.press("Control+.");
      await expect(page.locator('[data-app-world="field"][data-scene-suspended="true"]')).toBeVisible();
      await page.keyboard.press("Control+.");
      await expect(page.locator('[data-app-world="game"]')).toBeVisible();
      await expect(page.locator("[data-game-manuscripts]")).toBeVisible();
      await expect(page).toHaveURL(/\/en\/app$/);
    });
  });
});
