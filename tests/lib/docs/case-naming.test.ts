import { describe, it, expect } from "vitest";
import {
  isValidCaseName,
  isValidPieceFileName,
  parsePieceFileName,
  buildPieceFileName,
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
