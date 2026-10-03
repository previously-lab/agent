import { describe, it, expect } from "vitest";
import {
  isValidDocFileName,
  parseDocFileName,
  buildDocFileName,
  isValidDate,
  startsWithFourDigits,
  type DocKind,
} from "@/lib/docs";

describe("isValidDate", () => {
  it("accepts real calendar days", () => {
    expect(isValidDate("2026-09-05")).toBe(true);
    expect(isValidDate("2026-02-28")).toBe(true);
  });
  it("rejects impossible dates and wrong shapes", () => {
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-9-5")).toBe(false);
    expect(isValidDate("09-05-2026")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });
});

describe("isValidDocFileName — dated kinds", () => {
  const kinds: DocKind[] = ["event", "person", "object", "place", "org", "research", "hypothesis", "task"];

  it("accepts <出生日期>-<标题>.md for every dated kind", () => {
    for (const kind of kinds) {
      expect(isValidDocFileName("2026-09-05-手机购买调研.md", kind)).toBe(true);
    }
  });

  it("rejects a title starting with four digits (the slice-id red line)", () => {
    for (const kind of kinds) {
      // "2026-09-05-1234.md" is exactly the slice-id shape YYYY-MM-DD-HHMM
      expect(isValidDocFileName("2026-09-05-1234.md", kind)).toBe(false);
      expect(isValidDocFileName("2026-09-05-2026预算.md", kind)).toBe(false);
    }
  });

  it("rejects a title starting with a 4-digit year-like prefix", () => {
    expect(isValidDocFileName("2026-09-05-2025年计划.md", "research")).toBe(false);
  });

  it("accepts titles containing digits elsewhere", () => {
    expect(isValidDocFileName("2026-09-05-apex3方案.md", "research")).toBe(true);
    expect(isValidDocFileName("2026-09-05-v2改版.md", "task")).toBe(true);
  });

  it("rejects bad dates, missing parts, and non-.md names", () => {
    expect(isValidDocFileName("2026-13-05-标题.md", "research")).toBe(false);
    expect(isValidDocFileName("2026-09-05.md", "research")).toBe(false); // no title
    expect(isValidDocFileName("2026-09-05-.md", "research")).toBe(false); // empty title
    expect(isValidDocFileName("2026-09-05-标题", "research")).toBe(false);
    expect(isValidDocFileName("2026-09-05-标题.txt", "research")).toBe(false);
  });

  it("rejects path separators and traversal", () => {
    expect(isValidDocFileName("2026-09-05-a/b.md", "research")).toBe(false);
    expect(isValidDocFileName("2026-09-05-a\\b.md", "research")).toBe(false);
    expect(isValidDocFileName("2026-09-05-..-x.md", "research")).toBe(false);
    expect(isValidDocFileName("../2026-09-05-x.md", "research")).toBe(false);
  });

  it("rejects surrounding whitespace", () => {
    expect(isValidDocFileName(" 2026-09-05-标题.md", "research")).toBe(false);
    expect(isValidDocFileName("2026-09-05-标题 .md", "research")).toBe(false);
  });
});

describe("isValidDocFileName — topic", () => {
  it("accepts plain <名字>.md", () => {
    expect(isValidDocFileName("用户手机.md", "topic")).toBe(true);
    expect(isValidDocFileName("apex.md", "topic")).toBe(true);
    expect(isValidDocFileName("面试复盘.md", "topic")).toBe(true);
  });

  it("rejects topic names starting with four digits (same namespace guard)", () => {
    expect(isValidDocFileName("2026计划.md", "topic")).toBe(false);
    expect(isValidDocFileName("1234.md", "topic")).toBe(false);
  });

  it("rejects dated shapes and unsafe names", () => {
    expect(isValidDocFileName("2026-09-05-标题.md", "topic")).toBe(false);
    expect(isValidDocFileName("a/b.md", "topic")).toBe(false);
    expect(isValidDocFileName(".md", "topic")).toBe(false);
  });
});

describe("parseDocFileName / buildDocFileName", () => {
  it("splits a dated name into date + title", () => {
    expect(parseDocFileName("2026-09-05-手机购买调研.md", "research")).toEqual({
      date: "2026-09-05",
      title: "手机购买调研",
    });
  });

  it("returns null for illegal names", () => {
    expect(parseDocFileName("2026-09-05-1234.md", "research")).toBeNull();
    expect(parseDocFileName("随便.md", "research")).toBeNull();
  });

  it("buildDocFileName composes and validates", () => {
    expect(buildDocFileName("research", "2026-09-05", "手机购买调研")).toBe(
      "2026-09-05-手机购买调研.md",
    );
    expect(buildDocFileName("topic", "", "用户手机")).toBe("用户手机.md");
    expect(() => buildDocFileName("research", "2026-09-05", "2025年的事")).toThrow();
    expect(() => buildDocFileName("research", "not-a-date", "标题")).toThrow();
  });
});

describe("startsWithFourDigits", () => {
  it("flags 4-digit-leading titles only", () => {
    expect(startsWithFourDigits("1234abc")).toBe(true);
    expect(startsWithFourDigits("2025年")).toBe(true);
    expect(startsWithFourDigits("v2abc")).toBe(false);
    expect(startsWithFourDigits("a1234")).toBe(false);
  });
});
