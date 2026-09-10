import { describe, it, expect } from "vitest";
import {
  modeFromSearch,
  modeFromPathname,
  parseAtParam,
  parseAtStartParam,
  stripAtParam,
  chatHref,
  timelineHref,
} from "@/lib/chat/mode-switch";

describe("modeFromSearch", () => {
  it("maps ?view=timeline to timeline mode, everything else to chat", () => {
    expect(modeFromSearch("?view=timeline")).toBe("timeline");
    expect(modeFromSearch("view=timeline")).toBe("timeline");
    expect(modeFromSearch("?view=chat")).toBe("chat");
    expect(modeFromSearch("")).toBe("chat");
    expect(modeFromSearch("?persona=user")).toBe("chat");
  });
});

describe("modeFromPathname", () => {
  it("is chat-only now that the /timeline route is gone", () => {
    expect(modeFromPathname("/timeline")).toBe("chat");
    expect(modeFromPathname("/")).toBe("chat");
    expect(modeFromPathname("/settings")).toBe("chat");
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
});

describe("stripAtParam", () => {
  it("removes only at and keeps the rest", () => {
    expect(stripAtParam("?at=x&persona=user")).toBe("?persona=user");
    expect(stripAtParam("?persona=user&at=x")).toBe("?persona=user");
    expect(stripAtParam("?at=x")).toBe("");
    expect(stripAtParam("")).toBe("");
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
    expect(
      parseAtStartParam("atStart=2026-08-11T10%3A00%3A00.000Z"),
    ).toBe("2026-08-11T10:00:00.000Z");
  });

  it("treats missing / blank / non-date values as no anchor", () => {
    expect(parseAtStartParam("?at=x")).toBeNull();
    expect(parseAtStartParam("?atStart=")).toBeNull();
    expect(parseAtStartParam("?atStart=%20")).toBeNull();
    expect(parseAtStartParam("?atStart=not-a-date")).toBeNull();
  });
});

describe("chatHref", () => {
  it("carries the anchor when present", () => {
    expect(chatHref("2026-08-01-1000")).toBe("/?at=2026-08-01-1000");
    expect(chatHref("a b")).toBe("/?at=a%20b");
  });

  it("falls back to the bare route without an anchor", () => {
    expect(chatHref(null)).toBe("/");
  });
});

describe("timelineHref", () => {
  it("carries the anchor when present", () => {
    expect(timelineHref("2026-08-01-1000")).toBe(
      "/?view=timeline&at=2026-08-01-1000",
    );
    expect(timelineHref("a b")).toBe("/?view=timeline&at=a%20b");
  });

  it("falls back to the view param without an anchor", () => {
    expect(timelineHref(null)).toBe("/?view=timeline");
  });
});
