import { describe, it, expect } from "vitest";
import {
  computeYearMarkers,
  resolveLabelledMarkers,
  parseRulerDate,
  TARGET_YEAR_PX,
  RULER_LABEL_RIGHT_PX,
} from "@/lib/timeline3d/ruler-math";

const RANGE = { oldest: "2024-03-15", now: "2026-06-20" };

describe("parseRulerDate", () => {
  it("parses a valid YYYY-MM-DD into local midnight", () => {
    const d = parseRulerDate("2026-06-20");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(20);
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseRulerDate("2026/06/20")).toBeNull();
    expect(parseRulerDate("2026-13-01")).toBeNull();
    expect(parseRulerDate("2026-02-30")).toBeNull();
    expect(parseRulerDate("not-a-date")).toBeNull();
  });
});

describe("computeYearMarkers", () => {
  it("returns null for an invalid range", () => {
    expect(computeYearMarkers({ oldest: "bogus", now: "2026-06-20" }, 800, 0)).toBeNull();
    // now <= oldest
    expect(computeYearMarkers({ oldest: "2026-06-20", now: "2026-06-20" }, 800, 0)).toBeNull();
  });

  it("returns no markers for a non-positive height", () => {
    expect(computeYearMarkers(RANGE, 0, 0)).toEqual([]);
  });

  it("places year markers TARGET_YEAR_PX apart, descending upward", () => {
    const height = 500;
    // stripHeight = max(dataYears-1, ceil(2h/100)) * 100; dataYears = 2024..2026 = 3,
    // requiredYears = ceil(1000/100) = 10 → unitCount 10, stripHeight 1000.
    const markers = computeYearMarkers(RANGE, height, 0)!;
    expect(markers.length).toBeGreaterThan(0);
    // Marker 0 (the current year) sits at stripHeight — always below the
    // viewport at progress 0 — so the topmost visible marker is i=5 at y=500.
    expect(markers[0].y).toBe(500);
    for (let i = 1; i < markers.length; i++) {
      expect(markers[i - 1].y - markers[i].y).toBe(TARGET_YEAR_PX);
      expect(markers[i - 1].year - markers[i].year).toBe(1);
    }
  });

  it("culls markers outside the viewport pad", () => {
    const markers = computeYearMarkers(RANGE, 500, 0)!;
    for (const m of markers) {
      expect(m.y).toBeGreaterThanOrEqual(-18);
      expect(m.y).toBeLessThanOrEqual(500 + 18);
    }
  });

  it("shifts markers up as progress increases", () => {
    const at0 = computeYearMarkers(RANGE, 500, 0)!;
    const atHalf = computeYearMarkers(RANGE, 500, 0.5)!;
    // stripHeight 1000, height 500 → max offset 500; half progress → 250 up.
    // Year 2020 (i=6, y 400 at progress 0) is visible at both positions.
    const y2020zero = at0.find((m) => m.year === 2020)!;
    const y2020half = atHalf.find((m) => m.year === 2020)!;
    expect(y2020zero.y).toBe(400);
    expect(y2020half.y).toBe(150);
  });

  it("extends past the data window for short ranges", () => {
    // 3 months of data: only 1-2 data years, but the strip must fill 2× height.
    const short = { oldest: "2026-04-01", now: "2026-06-20" };
    const markers = computeYearMarkers(short, 800, 0)!;
    const years = markers.map((m) => m.year);
    expect(Math.min(...years)).toBeLessThan(2026 - 5); // well past the data
  });
});

describe("resolveLabelledMarkers", () => {
  const H = 800;

  it("keeps every marker spaced at or above the gap, oldest-on-top order", () => {
    const markers = computeYearMarkers(RANGE, H, 0.3)!;
    const labelled = resolveLabelledMarkers(markers, H);
    expect(labelled.length).toBeGreaterThan(0);
    for (let i = 1; i < labelled.length; i++) {
      expect(labelled[i].y - labelled[i - 1].y).toBeGreaterThanOrEqual(40);
    }
    const sorted = [...labelled].sort((a, b) => a.y - b.y);
    expect(labelled).toEqual(sorted);
  });

  it("hides the older label when two markers collide", () => {
    // Two markers 25px apart — the upper (older) one must lose its label.
    const colliding = [
      { year: 2024, y: 300 },
      { year: 2025, y: 325 },
    ];
    const labelled = resolveLabelledMarkers(colliding, H);
    expect(labelled.map((m) => m.year)).toEqual([2025]);
  });

  it("keeps the newer label when markers sit exactly at the gap", () => {
    const touching = [
      { year: 2024, y: 300 },
      { year: 2025, y: 340 },
    ];
    const labelled = resolveLabelledMarkers(touching, H);
    expect(labelled.map((m) => m.year)).toEqual([2024, 2025]);
  });

  it("drops markers outside the viewport", () => {
    const markers = [
      { year: 2023, y: -5 },
      { year: 2024, y: 100 },
      { year: 2025, y: H + 5 },
    ];
    const labelled = resolveLabelledMarkers(markers, H);
    expect(labelled.map((m) => m.year)).toEqual([2024]);
  });

  it("honours a custom min gap", () => {
    const markers = [
      { year: 2023, y: 300 },
      { year: 2024, y: 360 },
    ];
    expect(resolveLabelledMarkers(markers, H, 40).map((m) => m.year)).toEqual([
      2023, 2024,
    ]);
    expect(resolveLabelledMarkers(markers, H, 100).map((m) => m.year)).toEqual([
      2024,
    ]);
  });
});

describe("label geometry", () => {
  it("keeps labels clear of the right-edge axis and year tick", () => {
    expect(RULER_LABEL_RIGHT_PX).toBe(10 + 24 + 5);
  });
});
