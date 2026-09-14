import { describe, it, expect } from "vitest";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  CARD_EM_MAX_PX,
  CARD_EM_MIN_PX,
  CARD_RATIO,
  DEFAULT_LEVEL,
  backingSheets,
  cardEmFor,
  cardGeometryFor,
  filterByStrand,
  frameGeometryFor,
  framePitchFor,
  frameVariantFor,
  groupForLevel,
  indexForAnchor,
  isoWeekFor,
  isoWeekKey,
  rowKeyFor,
  rowPitchFor,
  sheetPose,
  weekLabelFor,
} from "@/lib/timeline3d/stacks";

let seq = 0;
function entry(
  iso: string,
  over: Partial<TimelineSliceEntry> = {},
): TimelineSliceEntry {
  seq += 1;
  const date = iso.slice(0, 10);
  const hm = iso.slice(11, 16).replace(":", "");
  return {
    id: `${date}-${hm}`,
    date,
    start: iso,
    turn_count: 2,
    status: "closed",
    focus: `focus ${seq}`,
    summary: "",
    tags: [],
    open_loops: [],
    decisions: [],
    strands: [],
    needs_marking: false,
    ...over,
  };
}

describe("rowKeyFor", () => {
  const e = entry("2024-08-17T01:21:00.000Z");
  it("keys by slice id / day / ISO week", () => {
    expect(rowKeyFor(e, 0)).toBe("2024-08-17-0121");
    expect(rowKeyFor(e, 1)).toBe("d:2024-08-17");
    expect(rowKeyFor(e, 2)).toBe("w:2024-W33");
  });
});

describe("isoWeekFor / isoWeekKey", () => {
  it("buckets a plain mid-month Saturday", () => {
    expect(isoWeekKey("2024-08-17")).toBe("2024-W33");
    expect(isoWeekFor("2024-08-17")).toMatchObject({
      year: 2024,
      week: 33,
      monday: "2024-08-12",
      sunday: "2024-08-18",
    });
  });

  it("a Sunday belongs to the week that started the previous Monday", () => {
    expect(isoWeekKey("2024-08-18")).toBe("2024-W33");
    expect(isoWeekKey("2024-09-01")).toBe("2024-W35"); // Sun of 8/26–9/1
  });

  it("rolls into the neighbouring ISO year around Jan 1", () => {
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01"); // Mon 12/30–1/5
    expect(isoWeekKey("2023-01-01")).toBe("2022-W52"); // Sun of 2022's last week
    expect(isoWeekKey("2026-02-01")).toBe("2026-W05"); // Sun of 1/26–2/1
  });

  it("pads single-digit week numbers", () => {
    expect(isoWeekKey("2024-01-04")).toBe("2024-W01");
  });
});

describe("weekLabelFor", () => {
  it("formats en as 'year Www · M/D–M/D'", () => {
    expect(weekLabelFor("2024-08-17", "en")).toBe("2024 W33 · 8/12–8/18");
  });

  it("formats zh with 周", () => {
    expect(weekLabelFor("2024-08-17", "zh-CN")).toBe("2024 第33周 · 8/12–8/18");
  });

  it("follows the ISO week year across a calendar-year boundary", () => {
    expect(weekLabelFor("2024-12-30", "en")).toBe("2025 W01 · 12/30–1/5");
  });
});

describe("groupForLevel", () => {
  const entries = [
    entry("2024-08-17T01:21:00.000Z", { strands: ["running"] }),
    entry("2024-08-17T09:00:00.000Z", { strands: ["work"] }),
    entry("2024-08-18T10:00:00.000Z", { strands: ["running"] }),
    entry("2024-09-01T08:00:00.000Z"),
  ];

  it("L0 keeps one entry per row, oldest first", () => {
    const rows = groupForLevel(entries, 0);
    expect(rows).toHaveLength(4);
    expect(rows[0].top.id).toBe("2024-08-17-0121");
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it("L1 stacks same-day slices with the NEWEST on top", () => {
    const rows = groupForLevel(entries, 1);
    expect(rows).toHaveLength(3);
    expect(rows[0].key).toBe("d:2024-08-17");
    expect(rows[0].count).toBe(2);
    expect(rows[0].top.id).toBe("2024-08-17-0900");
    expect(rows[0].strands).toEqual(["running", "work"]);
  });

  it("L2 stacks by ISO week (Monday start)", () => {
    const rows = groupForLevel(entries, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe("w:2024-W33"); // 8/12–8/18 holds 08-17 ×2 + 08-18
    expect(rows[0].count).toBe(3);
    expect(rows[1].key).toBe("w:2024-W35"); // 8/26–9/1 holds Sunday 09-01
    expect(rows[1].count).toBe(1);
  });

  it("sorts defensively when input is unordered", () => {
    const rows = groupForLevel([entries[2], entries[0], entries[1]], 1);
    expect(rows.map((r) => r.key)).toEqual(["d:2024-08-17", "d:2024-08-18"]);
  });

  it("handles an empty catalog", () => {
    expect(groupForLevel([], 1)).toEqual([]);
  });
});

describe("indexForAnchor", () => {
  const entries = [
    entry("2024-08-17T01:21:00.000Z"),
    entry("2024-08-17T09:00:00.000Z"),
    entry("2024-08-18T10:00:00.000Z"),
  ];

  it("finds the row containing the anchor entry (any level)", () => {
    const days = groupForLevel(entries, 1);
    // Anchored on the OLDER member of the 08-17 stack → that stack.
    expect(indexForAnchor(days, "2024-08-17-0121")).toBe(0);
    const weeks = groupForLevel(entries, 2); // all three in 2024-W33
    expect(indexForAnchor(weeks, "2024-08-18-1000")).toBe(0);
  });

  it("falls back to the nearest row by time when the entry is gone (filter)", () => {
    const days = groupForLevel(entries.slice(2), 1); // only 08-18 remains
    expect(indexForAnchor(days, "2024-08-17-0121")).toBe(0);
  });

  it("returns -1 for empty rows", () => {
    expect(indexForAnchor([], "2024-08-17-0121")).toBe(-1);
  });
});

describe("filterByStrand normalises BOTH sides", () => {
  // The band highlights a strand by its NORMALISED name (`ink.ts`), while
  // `strands.json` keeps the first spelling it ever saw and a slice's own tags
  // keep whatever the agent wrote that turn. Comparing raw strings made the
  // two views disagree about one pick: the strip lit a thread for slices the
  // pane had filtered out.
  const spellings = [
    entry("2024-08-17T01:21:00.000Z", { strands: ["Fitness"] }),
    entry("2024-08-18T10:00:00.000Z", { strands: ["fitness "] }),
    entry("2024-08-19T10:00:00.000Z", { strands: ["Ｆｉｔｎｅｓｓ"] }),
    entry("2024-08-20T10:00:00.000Z", { strands: ["running"] }),
  ];

  it("matches every spelling of one strand, whichever one is picked", () => {
    expect(filterByStrand(spellings, ["Fitness"])).toHaveLength(3);
    expect(filterByStrand(spellings, ["fitness"])).toHaveLength(3);
    expect(filterByStrand(spellings, [" FITNESS "])).toHaveLength(3);
  });

  it("still excludes a strand that is genuinely absent", () => {
    expect(filterByStrand(spellings, ["swimming"])).toHaveLength(0);
  });
});

describe("filterByStrand", () => {
  const entries = [
    entry("2024-08-17T01:21:00.000Z", { strands: ["running"] }),
    entry("2024-08-18T10:00:00.000Z", { strands: ["work", "running"] }),
    entry("2024-08-19T10:00:00.000Z", { strands: ["work"] }),
  ];

  it("no strands keeps everything (核心时间线)", () => {
    expect(filterByStrand(entries, [])).toBe(entries);
  });

  it("keeps only carriers of the strand", () => {
    expect(filterByStrand(entries, ["running"])).toHaveLength(2);
    expect(filterByStrand(entries, ["work"])).toHaveLength(2);
    expect(filterByStrand(entries, ["nope"])).toHaveLength(0);
  });

  it("UNIONS several strands rather than intersecting them", () => {
    // All three slices carry one or the other; none carries both "work" and
    // "running" alone, so an intersection would return two, not three.
    expect(filterByStrand(entries, ["running", "work"])).toHaveLength(3);
  });

  it("returns the same carrier for a strand repeated in the list", () => {
    expect(filterByStrand(entries, ["work", "work"])).toHaveLength(2);
  });
});

describe("level constants", () => {
  it("lands on day stacks", () => {
    expect(DEFAULT_LEVEL).toBe(1);
  });
});

describe("cardGeometryFor", () => {
  it("uses responsive width tiers", () => {
    expect(cardGeometryFor(1600).cardW).toBe(380);
    expect(cardGeometryFor(800).cardW).toBe(340);
    const mobile = cardGeometryFor(390);
    expect(mobile.cardW).toBe(302); // 390 - 88
    expect(cardGeometryFor(300).cardW).toBe(260); // clamped
  });

  it("keeps the card aspect and derives row pitch", () => {
    const geo = cardGeometryFor(1600);
    expect(geo.cardH).toBe(Math.round(geo.cardW / CARD_RATIO));
    expect(rowPitchFor(0, geo)).toBe(geo.cardH + geo.gapSlice);
    expect(rowPitchFor(1, geo)).toBe(geo.cardH + geo.gapStack);
    expect(rowPitchFor(2, geo)).toBe(geo.cardH + geo.gapStack);
  });
});

describe("sheetPose", () => {
  it("is deterministic per group + sheet", () => {
    expect(sheetPose("d:2024-08-17", 0)).toEqual(sheetPose("d:2024-08-17", 0));
    expect(sheetPose("d:2024-08-17", 0)).not.toEqual(sheetPose("d:2024-08-17", 1));
  });

  it("cascades: deeper sheets peek further, in one stable direction", () => {
    for (const key of ["a", "b", "w:2024-W33", "d:2024-08-17", "x"]) {
      const poses = [0, 1, 2].map((i) => sheetPose(key, i));
      for (const p of poses) {
        expect(Math.abs(p.rotate)).toBeLessThanOrEqual(5.4);
        expect(Math.abs(p.rotate)).toBeGreaterThanOrEqual(0.3);
        expect(p.offsetY).toBeGreaterThan(0);
        // Fan tilt opposes the slip direction (right side lower).
        expect(Math.sign(p.rotate)).toBe(-Math.sign(p.offsetX));
      }
      for (let i = 1; i < poses.length; i++) {
        expect(Math.abs(poses[i].offsetX)).toBeGreaterThan(
          Math.abs(poses[i - 1].offsetX),
        );
        expect(poses[i].offsetY).toBeGreaterThan(poses[i - 1].offsetY);
      }
    }
  });
});

describe("frameGeometryFor (Rev 11)", () => {
  it("uses a landscape card for the dossier variant", () => {
    const geo = frameGeometryFor("dossier", 1424, 902);
    expect(geo.cardW).toBe(Math.round(Math.min(1424 * 0.78, 900)));
    expect(geo.cardH).toBe(Math.round(Math.min(geo.cardW / 1.5, 902 * 0.82)));
    expect(geo.cardW / geo.cardH).toBeCloseTo(1.5, 1);
    expect(geo.cardH).toBeLessThanOrEqual(902 * 0.82);
  });

  it("keeps the portrait frame logic for the portrait variant", () => {
    const geo = frameGeometryFor("portrait", 800, 902);
    expect(geo.cardH).toBe(Math.round(Math.min(Math.max(902 * 0.7, 300), 720)));
    expect(geo.cardW).toBeLessThanOrEqual(geo.cardH);
    expect(geo.cardW).toBeGreaterThan(0);
  });

  it("clamps the portrait height between 300 and 720", () => {
    expect(frameGeometryFor("portrait", 800, 2000).cardH).toBe(720);
    expect(frameGeometryFor("portrait", 800, 300).cardH).toBe(300);
  });

  it("never lets the card overflow the field width", () => {
    const mobile = frameGeometryFor("portrait", 390, 700);
    expect(mobile.cardW).toBeLessThanOrEqual(390 - 40);
    expect(mobile.cardW).toBeGreaterThanOrEqual(240);
  });

  it("carries the variant it was built with", () => {
    // The variant is what `frame-card.tsx` reads to pick its type scale and
    // its ledger length, so a geometry that drops it would silently fall back
    // to the dossier's 1/26 em — the 8.9px body text this exists to fix.
    expect(frameGeometryFor("portrait", 800, 902).variant).toBe("portrait");
    expect(frameGeometryFor("dossier", 1424, 902).variant).toBe("dossier");
  });

  it("derives a pitch that shows ~1.2-1.5 cards per screen", () => {
    const geo = frameGeometryFor("dossier", 1424, 902);
    expect(geo.pitch).toBeGreaterThan(geo.cardH);
    expect(902 / geo.pitch).toBeGreaterThanOrEqual(1.1);
    expect(902 / geo.pitch).toBeLessThanOrEqual(2);
  });
});

describe("framePitchFor (Rev 10)", () => {
  const geo = frameGeometryFor("dossier", 1424, 902);
  it("slice rows pack tighter than stack rows (the pile needs the gap)", () => {
    expect(framePitchFor(0, geo)).toBeLessThan(framePitchFor(1, geo));
    expect(framePitchFor(1, geo)).toBe(framePitchFor(2, geo));
  });
});

describe("backingSheets (Rev 10 tiers)", () => {
  it("small piles show their real count, mid piles read as five, big as seven", () => {
    expect(backingSheets(1)).toBe(0);
    expect(backingSheets(2)).toBe(1);
    expect(backingSheets(3)).toBe(2);
    expect(backingSheets(4)).toBe(4);
    expect(backingSheets(8)).toBe(4);
    expect(backingSheets(9)).toBe(6);
    expect(backingSheets(700)).toBe(6);
  });
});

describe("frameVariantFor — the PANE picks the document", () => {
  it("gives a pane taller than it is wide the portrait document", () => {
    // 640x1130: the pane is 608 wide and ~1130 tall.
    expect(frameVariantFor(608, 1130)).toBe("portrait");
    // A 390 phone.
    expect(frameVariantFor(358, 844)).toBe("portrait");
  });

  it("gives a wide pane the dossier", () => {
    expect(frameVariantFor(976, 900)).toBe("dossier");
    expect(frameVariantFor(1544, 1000)).toBe("dossier");
  });

  it("parts company with the window on a TALL window — the case that was wrong", () => {
    // A 1024x1400 window: the old rule read the window (>= 1024 → laptop) and
    // handed this pane the dossier, whose landscape card is 507px tall inside
    // 1400px of height. The pane rule sees a tall pane and says portrait.
    const paneW = 976;
    const paneH = 1400;
    expect(frameVariantFor(paneW, paneH)).toBe("portrait");
  });

  it("keeps a merely square-ish pane on the dossier", () => {
    // The margin exists so a pane that is only a little taller than wide does
    // not lose its ledger rows.
    expect(frameVariantFor(800, 800 * 1.1)).toBe("dossier");
    expect(frameVariantFor(800, 800 * 1.2)).toBe("portrait");
  });
});

describe("cardEmFor — the card's root em, bounded", () => {
  const portrait = (w: number, h: number) =>
    cardEmFor(frameGeometryFor("portrait", w, h));
  const dossier = (w: number, h: number) =>
    cardEmFor(frameGeometryFor("dossier", w, h));

  it("leaves the phone alone", () => {
    // 390x844 measures an 18.7px em today; the bounds must not move it.
    const em = portrait(358, 844);
    expect(em).toBeGreaterThan(CARD_EM_MIN_PX);
    expect(em).toBeLessThan(CARD_EM_MAX_PX);
  });

  it("caps the case that was 33px", () => {
    // 640x1130 measured a 568x720 card and a 33.4px em — 1.8x a phone's type
    // on a 1.6x wider window, with body rows at 24.7px.
    const geo = frameGeometryFor("portrait", 608, 1130);
    expect(cardEmFor(geo)).toBe(CARD_EM_MAX_PX);
  });

  it("caps the wide dossier too", () => {
    // 1600x1000 measured 23.1px unbounded.
    const geo = frameGeometryFor("dossier", 1544, 1000);
    expect(cardEmFor(geo)).toBe(CARD_EM_MAX_PX);
  });

  it("never leaves the bounds, at any card the two variants can make", () => {
    for (const variant of ["portrait", "dossier"] as const) {
      for (const w of [200, 320, 608, 976, 1544, 2400]) {
        for (const h of [300, 600, 900, 1400]) {
          const em = cardEmFor(frameGeometryFor(variant, w, h));
          expect(em).toBeGreaterThanOrEqual(CARD_EM_MIN_PX);
          expect(em).toBeLessThanOrEqual(CARD_EM_MAX_PX);
        }
      }
    }
  });

  it("is monotonic in the card — a bigger card never gets smaller type", () => {
    expect(dossier(1400, 800)).toBeGreaterThanOrEqual(dossier(600, 800));
    expect(portrait(900, 1200)).toBeGreaterThanOrEqual(portrait(400, 600));
  });
});
