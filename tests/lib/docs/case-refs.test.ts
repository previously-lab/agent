import { describe, it, expect } from "vitest";
import {
  parseCaseRef,
  resolveCaseRefPaths,
  normalizeCaseRefText,
  CASE_CATEGORIES,
  LEGACY_DOC_ROOTS,
  type CaseRef,
} from "@/lib/docs";

describe("normalizeCaseRefText — legacy decoration stripping", () => {
  it("strips 《》, .md, and surrounding slashes", () => {
    expect(normalizeCaseRefText("《用户手机》")).toBe("用户手机");
    expect(normalizeCaseRefText("research/手机调研/2026-09-08-报价篇.md")).toBe(
      "research/手机调研/2026-09-08-报价篇",
    );
    expect(normalizeCaseRefText("/research/手机调研/")).toBe("research/手机调研");
  });
});

describe("parseCaseRef — two-segment references", () => {
  it("分类/case名 → the case's index", () => {
    expect(parseCaseRef("research/手机购买调研")).toEqual({
      kind: "case",
      category: "research",
      caseName: "手机购买调研",
    });
    expect(parseCaseRef("people/user")).toEqual({
      kind: "case",
      category: "people",
      caseName: "user",
    });
    expect(parseCaseRef("self/search")).toEqual({
      kind: "case",
      category: "self",
      caseName: "search",
    });
  });

  it("分类/case名/篇名 → a piece (.md optional)", () => {
    expect(parseCaseRef("research/手机购买调研/2026-09-08-报价篇")).toEqual({
      kind: "piece",
      category: "research",
      caseName: "手机购买调研",
      pieceFileName: "2026-09-08-报价篇.md",
    });
    expect(parseCaseRef("research/手机购买调研/2026-09-08-报价篇.md")).toEqual({
      kind: "piece",
      category: "research",
      caseName: "手机购买调研",
      pieceFileName: "2026-09-08-报价篇.md",
    });
  });

  it("tolerates 《》 and path prefixes on new-root refs", () => {
    expect(parseCaseRef("《research/手机购买调研》")).toEqual({
      kind: "case",
      category: "research",
      caseName: "手机购买调研",
    });
  });

  it("DEAD LINK: illegal names return null (visible, not thrown)", () => {
    expect(parseCaseRef("research/2026计划")).toBeNull(); // case name red line
    expect(parseCaseRef("research/x/2026-09-08-1234")).toBeNull(); // piece red line
    expect(parseCaseRef("research/x/篇名无日期")).toBeNull(); // not a piece name
  });

  it("a non-category path falls back to the legacy name (its last segment)", () => {
    expect(parseCaseRef("nosuchcategory/x")).toEqual({ kind: "legacy", name: "x" });
    expect(parseCaseRef("")).toBeNull();
    expect(parseCaseRef("《》")).toBeNull();
  });
});

describe("parseCaseRef — legacy references (old root)", () => {
  it("a bare legacy name resolves as legacy", () => {
    expect(parseCaseRef("用户手机")).toEqual({ kind: "legacy", name: "用户手机" });
    expect(parseCaseRef("2026-09-05-手机购买调研")).toEqual({
      kind: "legacy",
      name: "2026-09-05-手机购买调研",
    });
  });

  it("an old-style path prefix strips down to the legacy name", () => {
    expect(parseCaseRef("memory/docs/topic/用户手机.md")).toEqual({
      kind: "legacy",
      name: "用户手机",
    });
    expect(parseCaseRef("docs/topic/用户手机")).toEqual({
      kind: "legacy",
      name: "用户手机",
    });
  });

  it("a legacy name that breaks the red line is a dead link", () => {
    expect(parseCaseRef("2025计划")).toBeNull();
  });
});

describe("resolveCaseRefPaths — new root first, legacy fallback", () => {
  it("case ref: index.md first, then every legacy root", () => {
    const paths = resolveCaseRefPaths(parseCaseRef("research/手机购买调研")!);
    expect(paths[0]).toBe("memory/research/手机购买调研/index.md");
    expect(paths.slice(1)).toEqual(
      LEGACY_DOC_ROOTS.map((root) => `${root}/手机购买调研.md`),
    );
  });

  it("piece ref: the piece first, then legacy kind directories", () => {
    const paths = resolveCaseRefPaths(
      parseCaseRef("research/手机购买调研/2026-09-08-报价篇")!,
    );
    expect(paths[0]).toBe("memory/research/手机购买调研/2026-09-08-报价篇.md");
    expect(paths).toContain("memory/docs/research/2026-09-08-报价篇.md");
    expect(paths).toContain("memory/docs/topic/2026-09-08-报价篇.md");
  });

  it("legacy ref: old docs kinds + old strand entities", () => {
    const paths = resolveCaseRefPaths(parseCaseRef("用户手机")!);
    expect(paths).toContain("memory/docs/topic/用户手机.md");
    expect(paths).toContain("memory/episodic/strands/用户手机.md");
    expect(paths.some((p) => p.startsWith("memory/research/"))).toBe(false);
  });

  it("new-root candidates never duplicate and never mix roots order", () => {
    for (const category of CASE_CATEGORIES) {
      const ref: CaseRef = { kind: "case", category, caseName: "x" };
      const paths = resolveCaseRefPaths(ref);
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths[0]).toBe(`memory/${category}/x/index.md`);
    }
  });
});
