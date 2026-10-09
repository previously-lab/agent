import { test, expect, type Page } from "@playwright/test";
import {
  clearEpisodic,
  makeSlice,
  seedSlices,
  type FixtureSlice,
} from "./memory-fixture";

/**
 * Memory-viz e2e, two-rungs rewrite (v0.26): the conversation is a FLOATING
 * layer — the pill by default, risen to fullscreen by the expand verb, by a
 * send, or by a slice jump — and the world has exactly two rungs: 原稿 /
 * Manuscript (the document reader) and 现场 / Scene (the hotel), switched by
 * the board bar through the shell's transition machine. The four-rung ladder
 * and its R3F conversation field are retired: `dom-chat-list.tsx` is the only
 * conversation surface, so these specs read a plain DOM scroller.
 *
 * What is covered: the arrival resume/briefing gate (the briefing card is a
 * stream item in the panel's list, between the cold-open history page and the
 * live edge; an EMPTY memory auto-rises the panel once), the cold-open page's
 * honest boundary (the panel pages NOTHING older — happened-time browsing
 * belongs to the archive dispatch), the search palette's jump-to-slice (which
 * RISES the panel), and the two-rung board bar + the Ctrl+. world toggle.
 *
 * All specs seed slice files + the timeline catalog straight into the
 * isolated MEMORY_ROOT (see memory-fixture.ts) — no chat turn ever runs, so
 * the bridge-mode dev server never needs a real agent CLI.
 *
 * Serialized within the file: every test rewrites the shared MEMORY_ROOT the
 * (single) dev server reads. The webServer env pins slicing.idleGapMinutes
 * to its 30-minute default, so "fresh" slices are seeded <10 min old and
 * "historical" ones in February 2026 (now ≈ September 2026).
 */

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

test.describe("Memory viz (two rungs)", () => {
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
        page.getByRole("button", { name: "Local", exact: true }),
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

  // The world has TWO rungs — 原稿 / Manuscript (the reader) and 现场 /
  // Scene (the hotel) — and the board bar is the control that moves between
  // them. The rung is the shell's IN-MEMORY state: the URL carries no
  // navigation (deep-link explains what little query contract remains), so
  // these tests drive the bar and assert on its own pressed state. The
  // conversation is not a rung — it floats above either world as the pill.
  test.describe("the two rungs", () => {
    /** The board bar's rung group and one tag in it. */
    const rungs = (page: Page) => page.getByRole("group", { name: "Worlds" });
    const rungButton = (page: Page, name: string) =>
      rungs(page).getByRole("button", { name });

    // The first hotel mount compiles the three.js chunk in dev — allow
    // triple the default timeout anywhere the game world mounts.
    test("the app opens on 原稿 and the board bar moves to 现场 and back", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en/app");
      // The opening rung is the reader: the Manuscript tag is pressed, the
      // library control is up, and the conversation floats as the pill.
      await expect(rungButton(page, "Manuscript")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.locator("[data-library-toggle]")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("button", { name: "Expand to full screen" }),
      ).toBeVisible();

      // To the hotel: the move is a transition, and once it settles the
      // game's own Exit is on screen and the board bar is gone — the hotel
      // keeps its viewport clear of product chrome.
      await rungButton(page, "Scene").click();
      await expect(page.getByRole("button", { name: "Exit" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(rungs(page)).toHaveCount(0, { timeout: 30_000 });

      // Back to the reader through the game's own exit.
      await page.getByRole("button", { name: "Exit" }).click();
      await expect(rungButton(page, "Manuscript")).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 30_000 },
      );
    });

    test("the draft survives a round trip through the hotel", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en/app");
      // Hydration gate before clicking (the onClick attaches on mount) — the
      // client badge only renders after its mount-time fetch resolved.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();

      // The pill's single-line input takes the draft.
      const pillInput = page.getByRole("textbox", { name: "Send a message..." });
      await expect(pillInput).toBeVisible();
      await pillInput.click();
      await page.keyboard.type("still here");
      await expect(pillInput).toHaveValue("still here");

      // The conversation layer lives at the LAYOUT, so the world switch does
      // not unmount it: the same pill floats over the hotel, draft intact.
      await rungButton(page, "Scene").click();
      await expect(page.getByRole("button", { name: "Exit" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(pillInput).toHaveValue("still here");

      // And back: same composer instance, same draft — and it survives
      // expanding to the fullscreen form too (one never-unmounted component).
      await page.getByRole("button", { name: "Exit" }).click();
      await expect(rungButton(page, "Manuscript")).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 30_000 },
      );
      await expect(pillInput).toHaveValue("still here");
      await page.getByRole("button", { name: "Expand to full screen" }).click();
      await expect(page.locator("textarea").first()).toHaveValue("still here");
    });

    test("Cmd/Ctrl+. toggles between the reader and the hotel", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en/app");
      // Same hydration gate as the search palette test — the Ctrl+. listener
      // attaches on mount.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();
      // The listener mounts after the gate button under full-suite load, so
      // press-until-toggled instead of firing once into a dead window. The
      // hotel's own Exit button is the "we are in 现场" assertion — the
      // board bar unmounts there, so it cannot answer.
      await expect(async () => {
        await page.keyboard.press("Control+.");
        await expect(page.getByRole("button", { name: "Exit" })).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 60_000 });
      // Toggling back before the hotel settles is a REVERSAL, not a drop —
      // the toggle reads the live move's destination. Still, gate on the
      // hotel having settled (the Exit above) so the assertions do not race
      // the transition machine.
      await expect(async () => {
        await page.keyboard.press("Control+.");
        await expect(rungButton(page, "Manuscript")).toHaveAttribute(
          "aria-pressed",
          "true",
          { timeout: 3_000 },
        );
      }).toPass({ timeout: 60_000 });
    });
  });
});
