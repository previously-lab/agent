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
 * `data-conversation-field` is the handle, and it replaced `div.touch-none`
 * for a concrete reason: the time rail's scrub surface also carries
 * `touch-none`, and the rail renders BEFORE the right pane in the document, so
 * a class selector started matching the rail and would have reported the chat
 * field's position from the wrong element entirely. The class is still
 * load-bearing (see `conversation-field.tsx` — without it the browser claims
 * the touch gesture and no pointermove arrives); it is just no longer the
 * identity.
 */
function conversationField(page: Page) {
  return page.locator("[data-conversation-field]");
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
        .getByRole("button", { name: "Load earlier" })
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

  // The app is ONE LADDER at four zooms — conversation → slice → day → week —
  // and the floating lens is the only control that moves along it. This block
  // used to test a `chat | timeline` VIEW switch owned by a header pill; both
  // the pill and the view param are gone (`src/lib/chat/deep-link.ts` explains
  // why), so the tests now drive the lens and assert on `?z=`.
  test.describe("the rung ladder", () => {
    /** The floating zoom lens. Its segments are named by rung. */
    const lens = (page: Page) => page.getByRole("group", { name: "Lens" });
    const lensButton = (page: Page, rung: string) =>
      lens(page).getByRole("button", { name: rung });

    // The first card-rung hit compiles the three.js chunk in dev — allow
    // triple the default timeout.
    test("a deep link renders the rung it names", async ({ page }) => {
      test.slow();
      await seedSlices(datasetA());

      const res = await page.goto("/en?z=slice");
      expect(res?.status()).toBe(200);
      await expect(lensButton(page, "Slice")).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      // The card field IS the data view at a card rung.
      await expect(page.locator(".tl-card-in").first()).toBeVisible({
        timeout: 30_000,
      });
      // The 「NOW · 现在」 caption that used to be asserted here is DELETED —
      // a label with no action sitting in the bottom centre, exactly where the
      // compact composer puts a button, so readers clicked it expecting the
      // button. It also said something the field already says: the bottom of
      // the list is now, and the core line's blue spine marks the present on
      // the rail. What replaces it as the "this rung is fully assembled"
      // assertion is the BOARD BAR: the zoom control and the strand selector,
      // which must exist at every rung because the lens is the only way back
      // to the conversation.
      await expect(page.locator("[data-board-bar]")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator("canvas").first()).toBeVisible({
        timeout: 30_000,
      });
    });

    test("the lens moves along the ladder over the live conversation", async ({
      page,
    }) => {
      test.slow();
      await seedSlices(datasetA());

      // `/` opens on the conversation — the finest rung — which is where the
      // app has always opened.
      await page.goto("/en");
      await expect(lensButton(page, "Conversation")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // Hydration gate before clicking (the onClick attaches on mount) — the
      // client badge only renders after its mount-time fetch resolved.
      await expect(
        page.getByRole("button", { name: "Local", exact: true }),
      ).toBeVisible();

      // Capture the conversation field's root so we can prove it survives.
      const stream = conversationField(page);
      const streamHandle = await stream.elementHandle();
      expect(streamHandle).toBeTruthy();

      await lensButton(page, "Slice").click();
      await expect(page).toHaveURL(/z=slice/);
      // The composer COLLAPSES here rather than staying up: at a card rung the
      // full box would be an empty card sitting on the field the reader is
      // looking at. What must not happen is the composer being lost — so the
      // compact form is on screen, and the textarea is deliberately absent
      // (this used to assert the opposite, back when the full form was merely
      // hidden). See `composer-host.tsx` and `chat-input.tsx`'s `collapsed`.
      await expect(page.locator("[data-composer-collapsed]")).toBeVisible();
      await expect(page.locator("[data-composer-pill]")).toBeVisible();
      await expect(page.locator("textarea")).toHaveCount(0);

      await expect(page.locator(".tl-card-in").first()).toBeVisible({
        timeout: 30_000,
      });

      // The conversation field is the same DOM node as before (still mounted).
      const isSameNode = await page.evaluate(
        (prev) => prev === document.querySelector("[data-conversation-field]"),
        streamHandle,
      );
      expect(isSameNode).toBe(true);

      // Back to the conversation: the default rung is written as NO param, so
      // the URL goes clean rather than carrying `?z=conversation`.
      await lensButton(page, "Conversation").click();
      await expect(page).not.toHaveURL(/z=/);
      // THE REAL INVARIANT, and a stronger one than the node identity above:
      // what the reader typed survives the round trip through a card rung.
      // That is the reason the composer is one never-unmounted component with
      // a render-prop form rather than two branches (see `composer-host.tsx`),
      // and it is the thing the old `toBeAttached()` was standing in for.
      const area = page.locator("textarea").first();
      await expect(area).toBeAttached();
      await area.click();
      await page.keyboard.type("still here");
      await expect(area).toHaveValue("still here");

      await lensButton(page, "Slice").click();
      await expect(page).toHaveURL(/z=slice/);
      await expect(page.locator("[data-composer-collapsed]")).toBeVisible();
      await expect(async () => {
        await page.locator("[data-composer-collapsed]").click();
        await expect(page.locator("textarea")).toBeVisible({ timeout: 3_000 });
      }).toPass();
      await expect(page.locator("textarea")).toHaveValue("still here");

      await expect(stream).toBeVisible();
    });

    test("Cmd/Ctrl+. toggles the conversation against the last card rung", async ({
      page,
    }) => {
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
        await expect(page).toHaveURL(/z=/, { timeout: 3_000 });
      }).toPass();
      // Wait for the scene to actually render before toggling back: a rung
      // change issued while the card field is still mounting is dropped,
      // swallowing the return toggle. Gate on the stack list being up.
      await expect(page.locator(".tl-card-in").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(async () => {
        await page.keyboard.press("Control+.");
        await expect(page).not.toHaveURL(/z=/, { timeout: 3_000 });
      }).toPass();
    });
  });
});
