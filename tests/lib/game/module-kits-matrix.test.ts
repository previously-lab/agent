/**
 * The module × archetype qualification matrix — the explicit lock the P2a
 * post-mortem called for (doc/design/v0.12b-p2a-report.md §1): a whitelist
 * edit or a kits.ts eligibility-gate change silently rewires WHICH kits a
 * module can deal in a room of a given archetype — and that silently
 * rewires composition MEMBERSHIP (primaryModulesFor/companionsFor both
 * draw on moduleKitsFor), while every pin that merely watches staging
 * stays green. Twice now the drift was caught only downstream: P2a's
 * bedroom lost its sole pool-hall-drawable kit and fell out of pool-hall
 * compositions, and v0.12b R2's foyer lost its second pool-hall kit the
 * same way (luggage banned by §12 — fixed with storage-rack, see
 * modules/service.ts).
 *
 * So the whole grid is pinned here, cell by cell, in plain kit ids (no
 * hashes — a diff must read like a catalogue edit). A deliberate change
 * updates the literal AND records its reason in this header; an
 * accidental one fails loudly, named module@archetype.
 *
 * Column order = INTERIOR_ROOMS (space-types.ts); cell order = the KITS
 * catalogue order moduleKitsFor filters in. [] = the module can furnish
 * NOTHING in that archetype — no primary seat, no companion seat either.
 */
import { describe, it, expect } from "vitest";
import { ROOM_MODULES, moduleKitsFor } from "@/lib/game/room-modules";
import { INTERIOR_ROOMS } from "@/lib/game/space-types";

const MATRIX: Record<string, Record<string, readonly string[]>> = {
  foyer: {
    "hotel-room": ["reception", "coat-bench", "clock-nook", "storage-rack"],
    "pool-hall": ["coat-bench", "storage-rack"],
    library: ["reception", "coat-bench", "clock-nook", "storage-rack"],
    ballroom: ["reception", "coat-bench", "clock-nook", "storage-rack"],
  },
  bedroom: {
    "hotel-room": ["bed-corner", "reading", "writing-desk", "vanity-corner", "wardrobe-wall"],
    "pool-hall": ["wardrobe-wall"],
    library: ["reading", "writing-desk", "wardrobe-wall"],
    ballroom: ["reading", "wardrobe-wall"],
  },
  study: {
    "hotel-room": ["reading", "writing-desk", "plant-pedestal"],
    "pool-hall": ["plant-pedestal"],
    library: ["reading", "bookshelf-run", "writing-desk", "plant-pedestal"],
    ballroom: ["reading", "bookshelf-run", "plant-pedestal"],
  },
  "reading-room": {
    "hotel-room": ["reading", "plant-pedestal", "clock-nook"],
    "pool-hall": ["plant-pedestal"],
    library: ["reading", "bookshelf-run", "gallery-bench", "plant-pedestal", "clock-nook"],
    ballroom: ["reading", "bookshelf-run", "gallery-bench", "plant-pedestal", "clock-nook"],
  },
  kitchen: {
    "hotel-room": ["dining", "kitchen-counter"],
    "pool-hall": ["kitchen-counter"],
    library: ["kitchen-counter"],
    ballroom: ["dining", "kitchen-counter"],
  },
  bath: {
    "hotel-room": ["coat-bench"],
    "pool-hall": ["lockers", "coat-bench", "towel-station", "towel-rail", "mop-corner"],
    library: ["lockers", "coat-bench"],
    ballroom: ["lockers", "coat-bench"],
  },
  storage: {
    "hotel-room": ["luggage", "housekeeping", "coat-bench", "storage-rack"],
    "pool-hall": ["luggage", "housekeeping", "coat-bench", "storage-rack"],
    library: ["luggage", "housekeeping", "coat-bench", "storage-rack"],
    ballroom: ["luggage", "housekeeping", "coat-bench", "storage-rack"],
  },
  "gallery-module": {
    "hotel-room": ["reading", "plant-pedestal", "art-wall"],
    "pool-hall": ["plant-pedestal", "art-wall"],
    library: ["reading", "gallery-bench", "plant-pedestal", "art-wall"],
    ballroom: ["reading", "gallery-bench", "plant-pedestal", "art-wall"],
  },
  living: {
    "hotel-room": ["reading", "tv-corner", "sofa-group", "plant-pedestal", "sideboard", "art-wall"],
    "pool-hall": ["plant-pedestal", "art-wall"],
    library: ["reading", "sofa-group", "plant-pedestal", "art-wall"],
    ballroom: ["reading", "tv-corner", "sofa-group", "plant-pedestal", "sideboard", "art-wall"],
  },
  sunroom: {
    "hotel-room": ["reading", "coat-bench", "plant-pedestal"],
    "pool-hall": ["coat-bench", "plant-pedestal"],
    library: ["reading", "coat-bench", "gallery-bench", "plant-pedestal", "fountain-court"],
    ballroom: ["reading", "coat-bench", "gallery-bench", "plant-pedestal", "fountain-court"],
  },
  "pool-deck": {
    "hotel-room": [],
    "pool-hall": ["pool-loungers", "towel-station", "ring-post", "poolside-bench", "ladder-board", "towel-rail"],
    library: [],
    ballroom: [],
  },
  "dining-hall": {
    "hotel-room": ["dining", "chair-stack", "sideboard"],
    "pool-hall": [],
    library: ["gallery-bench", "chair-stack"],
    ballroom: ["dining", "gallery-bench", "chair-stack", "sideboard"],
  },
  workshop: {
    "hotel-room": ["housekeeping", "coat-bench", "writing-desk", "chair-stack", "workbench-corner"],
    "pool-hall": ["lockers", "housekeeping", "coat-bench", "workbench-corner"],
    library: ["lockers", "housekeeping", "coat-bench", "writing-desk", "chair-stack", "workbench-corner"],
    ballroom: ["lockers", "housekeeping", "coat-bench", "chair-stack", "workbench-corner"],
  },
};

describe("module × archetype qualification matrix (the P2a/R2 lock)", () => {
  it("pins every standard module's drawable kits across the four interior archetypes", () => {
    expect(Object.keys(MATRIX), "the matrix must cover the catalogue in its frozen order").toEqual(
      ROOM_MODULES.map((m) => m.id),
    );
    for (const m of ROOM_MODULES) {
      const row = MATRIX[m.id];
      expect(
        Object.keys(row),
        `${m.id}: the row must cover exactly the four interior archetypes`,
      ).toEqual([...INTERIOR_ROOMS]);
      for (const a of INTERIOR_ROOMS) {
        const live = moduleKitsFor(m, a).map((k) => k.id);
        expect(
          live,
          `${m.id} @ ${a}: the drawable kit set moved — deliberate whitelist/eligibility ` +
            `changes update this literal AND record their reason in the header; ` +
            `anything else is the P2a/R2 membership drift this matrix exists to catch`,
        ).toEqual([...row[a]]);
      }
    }
  });
});
