import { describe, it, expect } from "vitest";
import {
  isValidCaseName,
  isValidPieceFileName,
  parsePieceFileName,
  buildPieceFileName,
  sanitizeCaseSegment,
} from "@/lib/docs";

describe("isValidCaseName — the naming red line", () => {
  it("accepts plain (name-only) case names", () => {
    expect(isValidCaseName("陈勇超")).toBe(true);
    expect(isValidCaseName("user")).toBe(true);
    expect(isValidCaseName("search")).toBe(true);
    expect(isValidCaseName("手机购买调研")).toBe(true);
    expect(isValidCaseName("屏幕供应商-报价")).toBe(true);
  });

  it("accepts dated case names (裁决版 §B.2): legal date + title not 4-digit-leading", () => {
    expect(isValidCaseName("2026-11-05-屏幕供应商")).toBe(true);
    expect(isValidCaseName("2026-10-04-一次面谈")).toBe(true);
  });

  it("rejects dated names whose TITLE segment starts with four digits (slice-id shape)", () => {
    expect(isValidCaseName("2026-11-05-1430")).toBe(false); // 撞 YYYY-MM-DD-HHMM
    expect(isValidCaseName("2026-11-05-2025年的事")).toBe(false);
  });

  it("rejects dated names with an impossible calendar date", () => {
    expect(isValidCaseName("2026-13-40-某某")).toBe(false);
    expect(isValidCaseName("2026-02-30-某某")).toBe(false);
  });

  it("rejects plain names starting with four digits", () => {
    expect(isValidCaseName("2026计划")).toBe(false);
    expect(isValidCaseName("1430")).toBe(false);
  });

  it("rejects path separators, traversal, and whitespace", () => {
    expect(isValidCaseName("a/b")).toBe(false);
    expect(isValidCaseName("a\\b")).toBe(false);
    expect(isValidCaseName("..")).toBe(false);
    expect(isValidCaseName("a..b")).toBe(false);
    expect(isValidCaseName(" leading")).toBe(false);
    expect(isValidCaseName("trailing ")).toBe(false);
    expect(isValidCaseName("")).toBe(false);
    expect(isValidCaseName(".")).toBe(false);
  });
});

describe("isValidPieceFileName", () => {
  it("accepts <出生日期>-<标题>.md", () => {
    expect(isValidPieceFileName("2026-09-05-手机购买调研.md")).toBe(true);
    expect(isValidPieceFileName("2026-09-05-开篇.md")).toBe(true);
  });

  it("rejects titles starting with four digits (the red line)", () => {
    expect(isValidPieceFileName("2026-09-05-1234.md")).toBe(false); // slice-id shape
    expect(isValidPieceFileName("2026-09-05-2025年计划.md")).toBe(false);
  });

  it("accepts digits elsewhere in the title", () => {
    expect(isValidPieceFileName("2026-09-05-v2改版.md")).toBe(true);
    expect(isValidPieceFileName("2026-09-05-报价v3.md")).toBe(true);
  });

  it("rejects bad dates and malformed names", () => {
    expect(isValidPieceFileName("2026-13-05-标题.md")).toBe(false);
    expect(isValidPieceFileName("2026-09-05.md")).toBe(false); // no title
    expect(isValidPieceFileName("2026-09-05-.md")).toBe(false); // empty title
    expect(isValidPieceFileName("标题.md")).toBe(false); // no date
    expect(isValidPieceFileName("2026-09-05-标题")).toBe(false); // no .md
    expect(isValidPieceFileName("2026-09-05-a/b.md")).toBe(false);
    expect(isValidPieceFileName("index.md")).toBe(false); // not a piece
  });
});

describe("parsePieceFileName / buildPieceFileName", () => {
  it("round-trips date + title", () => {
    expect(parsePieceFileName("2026-09-05-手机购买调研.md")).toEqual({
      date: "2026-09-05",
      title: "手机购买调研",
    });
  });

  it("returns null for illegal names", () => {
    expect(parsePieceFileName("2026-09-05-1234.md")).toBeNull();
    expect(parsePieceFileName("随便.md")).toBeNull();
  });

  it("buildPieceFileName validates and throws", () => {
    expect(buildPieceFileName("2026-09-05", "手机购买调研")).toBe(
      "2026-09-05-手机购买调研.md",
    );
    expect(() => buildPieceFileName("2026-09-05", "2025年的事")).toThrow();
    expect(() => buildPieceFileName("not-a-date", "标题")).toThrow();
  });
});

describe("platform safety — the 2026-10-12 incident", () => {
  it("sanitizeCaseSegment maps ':' to the full-width '：' (the corpus convention)", () => {
    expect(sanitizeCaseSegment("两种情形：钱、可持续性，与 16:00 那场腾讯云")).toBe(
      "两种情形：钱、可持续性，与 16：00 那场腾讯云",
    );
  });

  it("sanitizeCaseSegment replaces the rest of the Windows-forbidden set with '-'", () => {
    expect(sanitizeCaseSegment('a<b>c"d|e?f*g')).toBe("a-b-c-d-e-f-g");
    // separators are structural, not typographic — refused by the validator,
    // never silently rewritten into a different identity
    expect(sanitizeCaseSegment("a/b")).toBe("a/b");
    expect(sanitizeCaseSegment("a\\b")).toBe("a\\b");
    expect(sanitizeCaseSegment("a--b")).toBe("a-b");
    expect(sanitizeCaseSegment(" a...b ")).toBe("a.b");
    expect(sanitizeCaseSegment("...")).toBe("");
    expect(sanitizeCaseSegment("x".repeat(200))).toBe("x".repeat(120));
  });

  it("case names with Windows-forbidden characters are refused", () => {
    expect(isValidCaseName("2026-10-12-与 16:00 那场腾讯云")).toBe(false);
    expect(isValidCaseName("a:b")).toBe(false);
    expect(isValidCaseName("a?b")).toBe(false);
    expect(isValidCaseName('a"b')).toBe(false);
    expect(isValidCaseName("a*b")).toBe(false);
    expect(isValidCaseName("a|b")).toBe(false);
    expect(isValidCaseName("a<b>c")).toBe(false);
    expect(isValidCaseName("报告.")).toBe(false);
    expect(isValidCaseName("nul")).toBe(false);
    expect(isValidCaseName("COM1")).toBe(false);
    expect(isValidCaseName("console")).toBe(true);
  });

  it("piece file names reject the incident title until sanitized (the regression)", () => {
    const title = "两种情形：钱、可持续性，与 16:00 那场腾讯云";
    expect(() => buildPieceFileName("2026-10-12", title)).toThrow();
    const safe = sanitizeCaseSegment(title);
    expect(safe).toBe("两种情形：钱、可持续性，与 16：00 那场腾讯云");
    expect(buildPieceFileName("2026-10-12", safe)).toBe(`2026-10-12-${safe}.md`);
    expect(isValidPieceFileName(`2026-10-12-${safe}.md`)).toBe(true);
  });
});
