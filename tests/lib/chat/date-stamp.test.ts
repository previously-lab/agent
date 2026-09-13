/**
 * The date/time decomposition behind the animated stamps: which numeric parts
 * a locale's date has, and whether the year is worth saying.
 *
 * Every expectation that touches a DAY or an HOUR derives it from the local
 * `Date` rather than from a hard-coded number. The stamp is deliberately in
 * the reader's zone (it sits next to a clock that is), so a fixture pinned to
 * UTC would pass in London and fail in Shanghai — which is exactly what the
 * first draft of this file did.
 */
import { describe, it, expect } from "vitest";
import { dateStampParts, timeStampParts } from "@/components/chat/date-stamp";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("dateStampParts", () => {
  it("splits a date into the parts the ticker animates", () => {
    const iso = "2026-08-02T19:08:00.000Z";
    expect(dateStampParts(iso, "en", NOW)).toEqual({
      monthNumber: 8,
      monthName: "August",
      day: new Date(iso).getDate(),
    });
  });

  it("carries the year only when it is NOT the current one", () => {
    // The same rule `formatSeamDate` uses, so a stamp and a seam heading never
    // disagree about whether the year is worth saying.
    expect(
      dateStampParts("2026-01-05T00:00:00.000Z", "en", NOW)?.yearNumber,
    ).toBeUndefined();
    expect(dateStampParts("2024-01-05T00:00:00.000Z", "en", NOW)?.yearNumber).toBe(
      2024,
    );
  });

  it("names the month in the reader's locale", () => {
    // The NAME, which the zh branch does not use — it prints the month NUMBER
    // with the "月" label, so "八月" never reaches the screen. Asserted anyway:
    // the decomposition is locale-agnostic and this is what it produces.
    expect(
      dateStampParts("2026-08-02T00:00:00.000Z", "zh", NOW)?.monthName,
    ).toBe("八月");
    expect(
      dateStampParts("2026-08-02T00:00:00.000Z", "zh", NOW)?.monthNumber,
    ).toBe(8);
  });

  it("returns null for an unparseable timestamp rather than rendering NaNs", () => {
    expect(dateStampParts("garbage", "en", NOW)).toBeNull();
    expect(dateStampParts("", "en", NOW)).toBeNull();
  });
});

describe("timeStampParts", () => {
  it("reads the hour and minute in the reader's own zone", () => {
    const iso = "2026-08-02T19:08:00.000Z";
    const d = new Date(iso);
    expect(timeStampParts(iso)).toEqual({
      hour: d.getHours(),
      minute: d.getMinutes(),
    });
  });

  it("returns null for an unparseable timestamp", () => {
    expect(timeStampParts("nope")).toBeNull();
  });
});
