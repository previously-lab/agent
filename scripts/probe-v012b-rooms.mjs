/**
 * The v0.12b room batch — one shot per standard room module, plus the mounted
 * room's own facts, in a single pass.
 *
 * WHY SELF-LOCATING. The earlier prop pass hard-coded door x positions and
 * mounted the wrong room half the time: the gallery materialises a sliding
 * window of doors, so a fixed x maps to a different door as the window moves.
 * Here the probe asks the game instead — `__gameDebug.windowDoors` names every
 * materialised door with its sliceId, x, z and side, so we slide the window
 * until the wanted door appears, teleport through its wall plane in ONE step
 * (the two-step recipe mounts the neighbour), and then verify by reading
 * `__gameDebug.room`: the mount is accepted only when the room we got is the
 * room we asked for.
 *
 * Facts land next to the images so the review has evidence, not just pixels:
 * which modules furnished, which of them went through a RoomSchematic, the
 * piece count and kinds, the trace, the feature slots, the water rectangle.
 *
 * Usage:
 *   node scripts/probe-v012b-rooms.mjs
 *   MODULES=living,sunroom node scripts/probe-v012b-rooms.mjs
 *   SCREENSHOT_BASE=http://localhost:3000 SHOT_DIR=shots/review/v0.12b ...
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "shots/review/v0.12b";
const SETTLE = Number(process.env.SETTLE_MS ?? 3500);
const MODULES = (
  process.env.MODULES ??
  "foyer,bedroom,study,reading-room,kitchen,bath,storage,gallery-module,living,sunroom,pool-deck,dining-hall,workshop"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// §14 merged the hotel into the single route: `/game` only redirects, and the
// redirect drops the query — the gallery lives on `/?view=game&debug=rooms`.
const GALLERY = "/en/?view=game&debug=rooms&page=modules";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(120000);

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push("[error] " + m.text().slice(0, 200));
});
page.on("pageerror", (e) =>
  problems.push("[pageerror] " + String(e?.message).slice(0, 200)),
);

/** The conversation panel is open by default and eats a third of the frame. */
async function collapsePanel() {
  const hit = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /collapse/i.test(b.getAttribute("aria-label") || ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  return hit;
}

async function boot() {
  await page.goto(BASE + GALLERY, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => !!globalThis.__gameDebug, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(SETTLE);
  await collapsePanel();
  await page.waitForTimeout(600);
}

/** Slide the gallery window until the wanted door is materialised.
 *  TWO measured quirks, both silent:
 *   - the gallery is a HOTEL with windows, and it materialises only the
 *     window's bays (`hotel: "core@0"` = eight doors). The five rooms past
 *     the eighth (living, sunroom, pool-deck, dining-hall, workshop) only
 *     appear once the player reaches the WEST end and the window advances
 *     (`core@1`), so the search walks west, one bay per hop.
 *   - `windowDoors[].x` reports the door's plan coordinate; its actual world
 *     position is its NEGATIVE (measured: teleporting to +3 mounts foyer,
 *     whose reported x is -3). mount() flips the sign. */
async function findDoor(want) {
  for (let hop = 0; hop < 14; hop++) {
    const info = await page.evaluate((want) => {
      const d = globalThis.__gameDebug;
      const doors = d.windowDoors ?? [];
      return {
        hit: doors.find((x) => x.sliceId === want) ?? null,
        doors: doors.map((x) => ({ id: x.sliceId, x: x.x, side: x.side })),
        px: d.x,
      };
    }, want);
    if (info.hit) return info.hit;
    const xs = info.doors.map((d) => -d.x).sort((a, b) => a - b);
    const pitch = Math.abs((xs[1] ?? 6) - (xs[0] ?? 0)) || 6;
    await page.evaluate(
      (x) => globalThis.__gameDebug?.teleport?.(x, 0),
      info.px - pitch,
    );
    await page.waitForTimeout(1400);
  }
  return null;
}

/** The gallery's canonical door order — which window a room lives in. The
 *  corridor materialises four bays (eight doors) per window, so the last five
 *  rooms only exist after the window advances. */
const CANON = [
  "foyer", "bedroom", "study", "reading-room", "kitchen", "bath", "storage",
  "gallery-module", "living", "sunroom", "pool-deck", "dining-hall", "workshop",
];
function windowIndexOf(id) {
  const i = CANON.indexOf(id);
  return i < 0 ? 0 : i < 8 ? 0 : 1;
}

async function hotelIndex() {
  const h = await page.evaluate(() => globalThis.__gameDebug?.hotel ?? "");
  const m = /@(\d+)\s*$/.exec(h);
  return m ? Number(m[1]) : -1;
}

async function readDoor(want) {
  return page.evaluate(
    (want) =>
      (globalThis.__gameDebug?.windowDoors ?? []).find((d) => d.sliceId === want) ??
      null,
    want,
  );
}

/** Park the corridor in the given window: the window only advances at the
 *  corridor's west end (and only walks back east), so step that way and poll
 *  the hotel string until it agrees. */
async function waitForWindow(want) {
  for (let i = 0; i < 16; i++) {
    const idx = await hotelIndex();
    if (idx === want) return true;
    const px = await page.evaluate(() => globalThis.__gameDebug?.x ?? 0);
    await page.evaluate(
      (x) => globalThis.__gameDebug?.teleport?.(x, 0),
      px + (idx < want ? -6 : 6),
    );
    await page.waitForTimeout(1500);
  }
  return false;
}

/** Mount the module: stand at the door, then step through its wall plane.
 *  `windowDoors` updates a beat before the corridor geometry does (measured:
 *  the list already names the next window's rooms while the player still
 *  stands in the previous one), so the mount waits for the window to settle
 *  and re-checks that the door is still there before stepping through. */
async function mount(id) {
  const want = `dbg-m:${id}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await boot();
    const door = await findDoor(want);
    if (!door) {
      console.log(`  ${id} attempt ${attempt}: door never materialised`);
      continue;
    }
    // `windowDoors` runs AHEAD of the corridor: the list can already name the
    // next window's rooms while the player still stands in the previous one,
    // and teleporting then mounts a different room (measured: asking for living
    // got storage). The hotel string is the honest signal, so the mount gates
    // on it and re-reads the door entry afterwards.
    const winIdx = windowIndexOf(id);
    if (!(await waitForWindow(winIdx))) {
      console.log(`  ${id} attempt ${attempt}: window ${winIdx} never arrived`);
      continue;
    }
    // The hotel string flips a beat before the new corridor's bays are built.
    await page.waitForTimeout(2200);
    const live = await readDoor(want);
    if (!live) {
      console.log(`  ${id} attempt ${attempt}: door absent in window ${winIdx}`);
      continue;
    }
    const z = live.side === "north" ? 7 : -7;
    // THE FRAMED VIEW. The gallery lights each room as an interior beyond its
    // door: standing in front of the door frames the room (the view the review
    // wants), and only stepping through swaps to the in-room camera. Shoot the
    // framed view while still in the corridor.
    await page.evaluate(
      ([x, z]) => globalThis.__gameDebug?.teleport?.(x, z),
      [-live.x, live.side === "north" ? 3.4 : -3.4],
    );
    await page.waitForTimeout(3400);
    await page.screenshot({ path: `${OUT}/${id}-door.png` });
    // Stand at the door first (still in the corridor), then step through.
    await page.evaluate(
      ([x, z]) => globalThis.__gameDebug?.teleport?.(x, z),
      [-live.x, live.side === "north" ? 3 : -3],
    );
    await page.waitForTimeout(1000);
    await page.evaluate(
      ([x, z]) => globalThis.__gameDebug?.teleport?.(x, z),
      [-live.x, z],
    );
    // A room takes a beat to build — poll for the mount instead of trusting a
    // fixed settle (measured: a short settle still reads `room: null` from the
    // corridor even though the step-through landed).
    for (let i = 0; i < 24; i++) {
      const got = await page.evaluate(
        () => globalThis.__gameDebug?.room?.sliceId ?? null,
      );
      if (got) break;
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(1200);
    const room = await page.evaluate(() => {
      const r = globalThis.__gameDebug?.room;
      if (!r) return null;
      return {
        sliceId: r.sliceId,
        cls: r.cls,
        topology: r.topology,
        width: r.width,
        extent: r.extent,
        doorWalls: r.doorWalls,
        modules: r.modules,
        schematics: r.schematics,
        furniture: r.furniture,
        pieceKinds: r.pieceKinds,
        features: r.features,
        trace: r.trace,
        placedDoors: r.placedDoors,
        water: globalThis.__gameDebug?.water
          ? {
              cx: globalThis.__gameDebug.water.cx,
              cz: globalThis.__gameDebug.water.cz,
              halfX: globalThis.__gameDebug.water.halfX,
              halfZ: globalThis.__gameDebug.water.halfZ,
            }
          : null,
      };
    });
    if (room && room.sliceId === want) return { room, door, attempt };
    console.log(
      `  ${id} attempt ${attempt}: mounted ${room?.sliceId ?? "null"} instead`,
    );
  }
  return null;
}

for (const id of MODULES) {
  const got = await mount(id);
  if (!got) {
    console.log(`  ${id}: FAILED`);
    continue;
  }
  const { room, door } = got;
  // THE ONE FRAME. The gallery mounts a room as a lit interior BEYOND the
  // corridor wall and keeps the player in the corridor (measured: the player
  // clamps at z ±4.5 no matter what). The camera sits behind the player and
  // looks along the corridor, so the room reads best from the OPPOSITE side:
  // stand across the corridor at the door's x and look over the low wall.
  await page.evaluate(
    ([x, z]) => globalThis.__gameDebug?.teleport?.(x, z),
    [-door.x, door.side === "north" ? -4.3 : 4.3],
  );
  await page.waitForTimeout(3400);
  await page.screenshot({ path: `${OUT}/${id}.png` });
  writeFileSync(
    `${OUT}/${id}.json`,
    JSON.stringify({ mountedAs: room.sliceId, door, room }, null, 2),
  );
  console.log(
    `  ${id}: ok — modules=[${room.modules.join(",")}] schematics=[${room.schematics.join(",")}] ` +
      `furniture=${room.furniture} features=[${room.features.join(",")}] trace=${room.trace?.kind ?? "none"}`,
  );
}

console.log(
  "  non-404 console errors:",
  problems.filter((p) => !p.includes("client/status")).length,
  problems.filter((p) => !p.includes("client/status")).slice(0, 3).join(" | "),
);
await browser.close();
console.log("done");
