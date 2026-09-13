import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  clearEpisodic,
  makeSlice,
  seedSlices,
  type FixtureSlice,
} from "./memory-fixture";

/**
 * v0.10 memory-viz e2e: the unified message stream (paging the older page in at
 * the window's head, and the seams that page is crossed at), the arrival
 * resume/briefing gate (Rev 2: the briefing seats as a stream-tail card), the
 * search palette's jump-to-slice, and the timeline view selected by
 * ?view=timeline (direct URL, the mode switcher, the Ctrl+. toggle).
 *
 * THE CONVERSATION HAS NO SCROLL CONTAINER (v0.12): position is a camera
 * offset the field owns and every block is a billboard, so these specs drive
 * the stream with the wheel and read the field's own DOM contract back
 * (`data-armed` on the armed boundary, the origin's solo face) instead of a
 * scroller's `scrollTop`. Read `conversation-field.tsx`'s header before
 * changing how any of this moves.
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
 * Move the conversation field's camera up by one wheel notch.
 *
 * THE CONVERSATION HAS NO SCROLL CONTAINER (v0.12): position is a camera
 * offset the field owns, and the wheel is the input that moves it — there is
 * no `scrollTop` to write and no element to write it on (see
 * `conversation-field.tsx`). The pointer only has to be over the pane for the
 * field's own `wheel` listener to receive the event.
 */
async function wheelUp(page: Page, px: number): Promise<void> {
  const size = page.viewportSize()!;
  await page.mouse.move(size.width * 0.6, size.height * 0.55);
  await page.mouse.wheel(0, -px);
}

/**
 * The head of the loaded window, ARMED — the only state in which it offers the
 * older page. Paging is ASKED FOR in this field, never inferred from a scroll
 * position, and this is where the reader asks. The field writes `data-armed`
 * on every boundary from its frame loop; the solo face is what tells the
 * window's head apart from a slice gate (see `field-origin.tsx`).
 */
function armedOrigin(page: Page) {
  return page.locator('[data-armed="true"]:has(.gate-face-solo)');
}

/**
 * The conversation field's ROOT — the element that owns the camera and the
 * wheel/pointer listeners, which makes it the field's equivalent of the
 * scroll container an earlier version could hand a test (`virtuoso-scroller`).
 * It is what "the chat stayed mounted" is true of.
 *
 * `touch-none` is the only handle on it: the class is load-bearing (see
 * `conversation-field.tsx` — without it the browser claims the touch gesture
 * and no pointermove arrives), and the card field that is mounted behind it in
 * the timeline view uses an inline `touchAction` instead, so this matches the
 * conversation field and nothing else. A `data-testid` would be a better hook
 * than a class; the product does not carry one.
 */
function conversationField(page: Page) {
  return page.locator("div.touch-none");
}

/**
 * The element's screen y once the camera has STOPPED moving.
 *
 * A boundary arms itself the moment the viewport comes within a slop of it,
 * while the camera is still easing toward its target — so an arming assertion
 * is not a settled one, and a position sampled there is a position in transit.
 * Two consecutive samples that agree are the field at rest.
 */
async function settledY(locator: Locator): Promise<number> {
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const y = (await locator.boundingBox())?.y ?? Number.NaN;
        const stable = Number.isFinite(y) && Math.abs(y - last) <= 0.5;
        last = y;
        return stable;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return last;
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

test.describe("Memory viz (v0.10)", () => {
  // NOT serial. Every test here seeds its OWN slices and `afterEach` clears
  // them, so the tests are already independent — and the config's one worker
  // is what stops them racing the shared dev server. Serial mode bought
  // nothing and cost a lot: one failure SKIPPED every test after it, so a
  // single known-broken case (see the briefing test below) hid five working
  // ones. A failure should now be exactly as loud as it is.


  test.afterEach(async () => {
    await clearEpisodic();
  });

  test.describe("unified message stream", () => {
    test("scroll-up pages older slices in across seams without losing the position", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      // Engage the stream by jumping to S09 (deep inside the initial 10-slice
      // page) — the time-travel clock plays, then the stream lands on S09's
      // seam. The landing is deliberately far from the window's head, so the
      // paging below is caused by the reader's own scroll, not by arriving.
      await page.goto(`/en?at=${slices[9].id}`);
      await expect(
        page.getByText(sentinel(slices[9], "user")),
      ).toBeVisible();
      // The initial page is the newest 10 slices: S00/S01 are NOT loaded yet.
      await expect(page.getByText(sentinel(slices[0], "user"))).toHaveCount(0);
      // ...and the head of that window is far above, so it is DORMANT: it
      // offers no older page until the reader actually stands in it.
      await expect(armedOrigin(page)).toHaveCount(0);

      // Scroll up to the head. The head arms itself there and offers the older
      // page — the one place where "show me earlier" is a coherent thing to
      // ask, because it is where the reader has arrived.
      await expect(async () => {
        await wheelUp(page, 2000);
        await expect(armedOrigin(page)).toHaveCount(1, { timeout: 2_000 });
      }).toPass({ timeout: 30_000 });

      // The reader's place, taken once the camera has come to rest in the head:
      // the oldest slice in the loaded window, at the top of the viewport.
      const anchor = page.getByText(sentinel(slices[2], "user"));
      await expect(anchor).toBeVisible();
      const beforeY = await settledY(anchor);

      await armedOrigin(page)
        .getByRole("button", { name: "Load earlier conversations" })
        .click();

      // The page lands: S00/S01 are in the window and the catalog is exhausted,
      // so the head stops offering an older page and reads as the beginning of
      // the memory instead.
      const head = page.getByText("The beginning of this memory");
      await expect(head).toHaveCount(1, { timeout: 20_000 });
      // The page arrived ABOVE the reader and pushed the head off-screen —
      // without that, the position assertion below would hold vacuously.
      await expect(head).not.toBeInViewport();

      // THE READER'S PLACE DID NOT MOVE. A block arriving ABOVE is the one
      // direction "a block is anchored by its top edge, so it grows downward
      // and moves nothing above it" cannot cover — so the field compensates
      // the camera by exactly the height the page added, and the turn the
      // reader was at the top of the viewport on is still at the same screen
      // y, with the new conversations off-screen above them to be scrolled
      // into. A failure here is the view jumping by a page's height.
      await expect
        .poll(async () => {
          const box = await anchor.boundingBox();
          return box === null ? null : Math.abs(box.y - beforeY);
        })
        .toBeLessThanOrEqual(2);

      // Now walk up into the page that arrived: the oldest slice's turns
      // render, and the boundary between the two slices that arrived is a real
      // GATE the reader passes through — not a hairline that got lost with the
      // page. (The gate is addressed by the conversations it stands between:
      // its intertitle names the older slice's focus on the back face.) The
      // checkpoint-vs-boundary wording the old seam carried is gone from the
      // product — every boundary is the same gate now.
      const seamGate = page
        .getByRole("separator", { name: "Between conversations" })
        .filter({ hasText: slices[0].focus! });
      await expect(async () => {
        await wheelUp(page, 1200);
        await expect(
          page.getByText(sentinel(slices[0], "user")),
        ).toBeVisible({ timeout: 2_000 });
        await expect(seamGate).toBeInViewport({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(page.getByText(sentinel(slices[0], "agent"))).toBeVisible();
    });
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

      await page.goto("/en");
      // chat.resume.banner — the restored turns sit directly under it.
      await expect(
        page.getByText(/Continuing the conversation from/),
      ).toBeVisible();
      await expect(page.getByText(sentinel(fresh, "user"))).toBeVisible();
      await expect(page.getByText(sentinel(fresh, "agent"))).toBeVisible();
      // The empty briefing is the OTHER branch — it must not render here.
      await expect(
        page.getByText("PREVIOUSLY ON", { exact: true }),
      ).toHaveCount(0);
    });

    test("seats the briefing as a stream-tail card with history above (Rev 2)", async ({
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

      await page.goto("/en");
      // §1.2 Rev 2: the stream is ALWAYS the view — the EmptyBriefing content
      // rides the stream's tail as a card (not a standalone briefing page).
      // Its eyebrow is `emptyBriefing.eyebrow`, rendered verbatim.
      const cardEyebrow = page.getByText("PREVIOUSLY ON", { exact: true });
      await expect(cardEyebrow).toBeVisible();
      await expect(page.locator("textarea")).toBeVisible();
      await expect(
        page.getByText(/Continuing the conversation from/),
      ).toHaveCount(0);

      // "History above" is literal: the card is the stream's TAIL, so it
      // renders below the historical turns in the same field — not above them
      // and not on a view of its own. (The seeded window fits the viewport
      // whole, so the two are on screen together rather than one scroll
      // apart; the scrolling half of that walk is covered by the paging spec
      // above.)
      const oldestTurn = page.getByText(sentinel(slices[0], "user"));
      await expect(oldestTurn).toBeVisible();
      await expect(page.getByText(sentinel(slices[0], "agent"))).toBeVisible();
      const cardBox = await cardEyebrow.boundingBox();
      const turnBox = await oldestTurn.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(turnBox).not.toBeNull();
      expect(cardBox!.y).toBeGreaterThan(turnBox!.y);
    });
  });


  test.describe("search palette", () => {
    test("Cmd/Ctrl+K searches the catalog and jumps to the slice in the stream", async ({
      page,
    }) => {
      const slices = datasetA();
      await seedSlices(slices);

      await page.goto("/en");
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

      // The palette closes and the stream jump lands on S07 (already inside
      // the initial page, so the travel clock is the only wait).
      await expect(page.locator("[cmdk-input]")).toHaveCount(0);
      await expect(
        page.getByText(sentinel(slices[7], "user")),
      ).toBeVisible();
      await expect(
        page.getByText(sentinel(slices[7], "agent")),
      ).toBeVisible();
    });
  });

  test.describe("timeline view", () => {
    const timelineUrl = /\/en.*view=timeline/;
    const chatUrl = /\/en\/?(\?|$)/;

    // The first timeline view hit compiles the three.js chunk in dev — allow
    // triple the default timeout.
    test("direct URL renders the timeline view in the shell", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());

      const res = await page.goto("/en?view=timeline");
      expect(res?.status()).toBe(200);
      // The header switcher shows the timeline segment active.
      await expect(
        page
          .getByRole("group", { name: "Switch view" })
          .getByRole("button", { name: "Timeline" }),
      ).toHaveAttribute("aria-pressed", "true");

      // The card field IS the data view.
      await expect(page.locator(".tl-card-in").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/NOW · now/)).toBeVisible();
      await expect(page.locator("canvas").first()).toBeVisible({
        timeout: 30_000,
      });
    });

    test("mode switcher toggles the timeline view over the live chat page", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en");
      await expect(
        page
          .getByRole("group", { name: "Switch view" })
          .getByRole("button", { name: "Chat" }),
      ).toHaveAttribute("aria-pressed", "true");
      // Hydration gate before clicking (the onClick attaches on mount) — the
      // client badge only renders after its mount-time fetch resolved.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();

      // Capture the chat stream root element handle so we can prove it survives.
      const stream = conversationField(page);
      const streamHandle = await stream.elementHandle();
      expect(streamHandle).toBeTruthy();

      // Soft navigation → the URL gains ?view=timeline while the chat page
      // stays mounted underneath.
      await page
        .getByRole("group", { name: "Switch view" })
        .getByRole("button", { name: "Timeline" })
        .click();
      await expect(page).toHaveURL(timelineUrl);
      // The chat input survives under the timeline pane (chat 常驻, §6.1).
      await expect(page.locator("textarea")).toBeAttached();

      // The timeline renders the same stack list as the direct URL.
      await expect(page.locator(".tl-card-in").first()).toBeVisible({
        timeout: 30_000,
      });

      // The chat stream is the same DOM node as before (still mounted).
      const isSameNode = await page.evaluate(
        (prev) => prev === document.querySelector("div.touch-none"),
        streamHandle,
      );
      expect(isSameNode).toBe(true);

      // Switching back to Chat drops the view param and restores the chat.
      await page
        .getByRole("group", { name: "Switch view" })
        .getByRole("button", { name: "Chat" })
        .click();
      await expect(page).toHaveURL(chatUrl);
      await expect(page.locator("textarea")).toBeAttached();
      await expect(stream).toBeVisible();
    });

    test("Cmd/Ctrl+. toggles between the two view modes", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());

      await page.goto("/en");
      // Same hydration gate as the search palette test — the Ctrl+. listener
      // attaches on mount.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();
      // The listener mounts after the gate button under full-suite load, so
      // press-until-navigated instead of firing once into a dead window.
      await expect(async () => {
        await page.keyboard.press("Control+.");
        await expect(page).toHaveURL(timelineUrl, { timeout: 3_000 });
      }).toPass();
      // Wait for the scene to actually render before toggling back: a
      // router.push issued while the timeline navigation is still in flight
      // is silently dropped (observed in the full-suite run), swallowing the
      // return toggle. Gate on the stack list being up.
      await expect(page.locator(".tl-card-in").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(async () => {
        await page.keyboard.press("Control+.");
        await expect(page).toHaveURL(chatUrl, { timeout: 3_000 });
      }).toPass();
    });
  });
});
