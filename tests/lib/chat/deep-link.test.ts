/**
 * Deep-link parsing for the single-route shell.
 *
 * This file used to be `mode-switch.test.ts` and covered a `chat | timeline`
 * view mode. The view became a RUNG (`deep-link.ts` explains why), so the view
 * half of these tests is gone and the rung half is here. The `at`/`atStart`
 * half is unchanged — that is the part that addresses a POINT in the memory
 * rather than a zoom, and it survived the rename untouched.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RUNG,
  parseAtParam,
  parseAtStartParam,
  parseRungParam,
  rungHref,
  stripAtParam,
} from "@/lib/chat/deep-link";

describe("parseRungParam", () => {
  it("reads every rung of the ladder", () => {
    expect(parseRungParam("?z=conversation")).toBe("conversation");
    expect(parseRungParam("?z=slice")).toBe("slice");
    expect(parseRungParam("?z=day")).toBe("day");
    expect(parseRungParam("?z=week")).toBe("week");
  });

  it("accepts a query string with or without the leading ?", () => {
    expect(parseRungParam("z=day")).toBe("day");
    expect(parseRungParam("persona=user&z=week")).toBe("week");
  });

  it("returns null when absent, blank, or not a rung", () => {
    // Null is the caller's signal to use DEFAULT_RUNG. An unrecognised `z` is a
    // stale or hand-edited link, and answering it with a valid rung would
    // silently ignore what the URL asked for.
    expect(parseRungParam("")).toBeNull();
    expect(parseRungParam("?z=")).toBeNull();
    expect(parseRungParam("?z=%20")).toBeNull();
    expect(parseRungParam("?z=timeline")).toBeNull(); // the OLD view param value
    expect(parseRungParam("?z=month")).toBeNull();
    expect(parseRungParam("?persona=user")).toBeNull();
  });
});

describe("rungHref", () => {
  it("writes NO param for the default rung, so the common URL stays clean", () => {
    expect(DEFAULT_RUNG).toBe("conversation");
    expect(rungHref("conversation")).toBe("/");
  });

  it("names a card rung", () => {
    expect(rungHref("slice")).toBe("/?z=slice");
    expect(rungHref("week")).toBe("/?z=week");
  });

  it("carries a reading-position anchor when present", () => {
    expect(rungHref("slice", "2026-08-01-1000")).toBe(
      "/?z=slice&at=2026-08-01-1000",
    );
    expect(rungHref("slice", "a b")).toBe("/?z=slice&at=a+b");
    // The default rung with an anchor is still a bare `?at=`, which is exactly
    // what the shell produces when it lands the conversation on a slice.
    expect(rungHref("conversation", "2026-08-01-1000")).toBe(
      "/?at=2026-08-01-1000",
    );
  });
});

describe("parseAtParam", () => {
  it("extracts the slice id", () => {
    expect(parseAtParam("?at=2026-08-01-1000")).toBe("2026-08-01-1000");
    expect(parseAtParam("at=2026-08-01-1000")).toBe("2026-08-01-1000");
    expect(parseAtParam("?persona=user&at=abc")).toBe("abc");
  });

  it("treats missing / blank / 'now' as no anchor", () => {
    expect(parseAtParam("")).toBeNull();
    expect(parseAtParam("?at=")).toBeNull();
    expect(parseAtParam("?at=now")).toBeNull();
    expect(parseAtParam("?at=%20")).toBeNull();
  });

  it("decodes encoded ids", () => {
    expect(parseAtParam("?at=a%20b")).toBe("a b");
  });

  it("ignores the rung, which rides in the same query string", () => {
    expect(parseAtParam("?z=slice&at=2026-08-01-1000")).toBe("2026-08-01-1000");
  });
});

describe("stripAtParam", () => {
  it("removes only at and keeps the rest", () => {
    expect(stripAtParam("?at=x&persona=user")).toBe("?persona=user");
    expect(stripAtParam("?persona=user&at=x")).toBe("?persona=user");
    expect(stripAtParam("?at=x")).toBe("");
    expect(stripAtParam("")).toBe("");
  });

  it("KEEPS the rung — the anchor is consumed once, the zoom is not", () => {
    // The chat page strips `at` after it has jumped. The rung has to survive
    // that: it is the reader's current position in the ladder, not a one-shot
    // instruction, and a refresh must keep it.
    expect(stripAtParam("?z=slice&at=x")).toBe("?z=slice");
    expect(stripAtParam("?at=x&z=week")).toBe("?z=week");
  });

  it("strips atStart along with at", () => {
    expect(
      stripAtParam("?at=x&atStart=2026-08-11T10%3A00%3A00.000Z&persona=user"),
    ).toBe("?persona=user");
    expect(stripAtParam("?atStart=2026-08-11T10:00:00.000Z")).toBe("");
  });
});

describe("parseAtStartParam", () => {
  it("extracts the ISO start", () => {
    expect(parseAtStartParam("?at=x&atStart=2026-08-11T10:00:00.000Z")).toBe(
      "2026-08-11T10:00:00.000Z",
    );
    expect(parseAtStartParam("atStart=2026-08-11T10%3A00%3A00.000Z")).toBe(
      "2026-08-11T10:00:00.000Z",
    );
  });

  it("treats missing / blank / non-date values as no anchor", () => {
    expect(parseAtStartParam("?at=x")).toBeNull();
    expect(parseAtStartParam("?atStart=")).toBeNull();
    expect(parseAtStartParam("?atStart=%20")).toBeNull();
    expect(parseAtStartParam("?atStart=not-a-date")).toBeNull();
  });
});
