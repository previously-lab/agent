import { describe, expect, it } from "vitest";
import {
  dateTimeFormat,
  formatterCacheSize,
} from "@/lib/time/formatter-cache";

describe("dateTimeFormat — one formatter per shape, not per call", () => {
  it("returns the SAME instance for the same locale and options", () => {
    // The whole point: constructing an Intl formatter resolves locale data,
    // and the chat stream was doing that inside its render path.
    const a = dateTimeFormat("en", { month: "short", day: "numeric" });
    const b = dateTimeFormat("en", { month: "short", day: "numeric" });
    expect(a).toBe(b);
  });

  it("does not care what order the options were written in", () => {
    const a = dateTimeFormat("en", { month: "short", day: "numeric" });
    const b = dateTimeFormat("en", { day: "numeric", month: "short" });
    expect(a).toBe(b);
  });

  it("separates locales", () => {
    const en = dateTimeFormat("en", { month: "short", day: "numeric" });
    const zh = dateTimeFormat("zh", { month: "short", day: "numeric" });
    expect(en).not.toBe(zh);
  });

  it("separates shapes", () => {
    const short = dateTimeFormat("en", { month: "short" });
    const long = dateTimeFormat("en", { month: "long" });
    expect(short).not.toBe(long);
  });

  it("treats an explicit undefined as absent, not as a second shape", () => {
    // `{ year: undefined }` and `{}` describe the same formatter. Keeping them
    // apart would split the cache for no reason, and the `sameYear` branches at
    // the call sites rely on the spread-with-undefined collapsing.
    const bare = dateTimeFormat("en", { month: "short" });
    const explicit = dateTimeFormat("en", { month: "short", year: undefined });
    expect(bare).toBe(explicit);
  });

  it("returns a working formatter", () => {
    const f = dateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    expect(f.format(new Date("2026-08-17T00:00:00Z"))).toBe("2026-08-17");
  });

  it("keeps the cache bounded by SHAPES, not by the values formatted", () => {
    // The invariant that makes an unevicted cache safe: formatting a thousand
    // different dates through one shape must not add a thousand entries.
    const f = dateTimeFormat("en", { month: "short", day: "numeric" });
    const afterFirst = formatterCacheSize();
    for (let i = 0; i < 500; i++) {
      f.format(new Date(Date.UTC(2026, 0, 1) + i * 86_400_000));
      dateTimeFormat("en", { month: "short", day: "numeric" });
    }
    expect(formatterCacheSize()).toBe(afterFirst);
  });
});
