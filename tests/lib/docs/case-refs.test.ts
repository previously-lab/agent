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

  it("REGRESSION (v0.23): the shelf's file-name ref (with .md) opens the listed piece", () => {
    // The bug the reader shipped with: the piece row built
    // `research/<case>/<篇名>.md` and the parse failed, so a listed
    // document came back "找不到这份文档". Both shapes must resolve.
    const expected = {
      kind: "piece",
      category: "research",
      caseName: "华北与北京落点",
      pieceFileName: "2026-10-05-华北与北京落点.md",
    };
    expect(
      parseCaseRef("research/华北与北京落点/2026-10-05-华北与北京落点.md"),
    ).toEqual(expected);
    expect(
      parseCaseRef("research/华北与北京落点/2026-10-05-华北与北京落点"),
    ).toEqual(expected);
    // A doubled suffix still strips down to the listed file.
    expect(
      parseCaseRef("research/华北与北京落点/2026-10-05-华北与北京落点.md.md"),
    ).toEqual(expected);
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

// REGRESSION (v0.24): NFKC in normalizeCaseRefText folded full-width
// punctuation/digits to half-width, so every case whose on-disk name carries
// （）：and friends resolved a path that does not exist and printed the
// not-found paper. The on-disk name is the identity: exact candidates
// first, the NFKC-folded variant only appended as a legacy fallback.
describe("full-width names — exact identity, folded fallback (v0.24)", () => {
  it("normalization does NOT fold full-width punctuation or digits", () => {
    expect(normalizeCaseRefText("research/厄尔尼诺对我国天气的影响（2026 年秋冬）")).toBe(
      "research/厄尔尼诺对我国天气的影响（2026 年秋冬）",
    );
    expect(normalizeCaseRefText("２０２６-０９-０５-手机购买调研")).toBe(
      "２０２６-０９-０５-手机购买调研",
    );
  });

  it("a full-width case name parses verbatim and its first candidate is the exact on-disk path", () => {
    const ref = parseCaseRef("research/RSI 的两种形态：脚手架式自我改进 vs 权重式自我改进");
    expect(ref).toEqual({
      kind: "case",
      category: "research",
      caseName: "RSI 的两种形态：脚手架式自我改进 vs 权重式自我改进",
    });
    const paths = resolveCaseRefPaths(ref!);
    expect(paths[0]).toBe(
      "memory/research/RSI 的两种形态：脚手架式自我改进 vs 权重式自我改进/index.md",
    );
    // The folded path exists only as a trailing fallback, after every exact
    // candidate, never replacing the identity.
    expect(paths[paths.length - 1]).toBe(
      "memory/episodic/strands/RSI 的两种形态:脚手架式自我改进 vs 权重式自我改进.md",
    );
    expect(paths).toContain(
      "memory/research/RSI 的两种形态:脚手架式自我改进 vs 权重式自我改进/index.md",
    );
  });

  it("a name that needs no fold gets no extra candidates (people/user)", () => {
    const ref = parseCaseRef("people/user");
    expect(ref).toEqual({ kind: "case", category: "people", caseName: "user" });
    const paths = resolveCaseRefPaths(ref!);
    expect(paths).toEqual([
      "memory/people/user/index.md",
      ...LEGACY_DOC_ROOTS.map((root) => `${root}/user.md`),
    ]);
  });

  it("a legacy citation written with full-width digits resolves via the folded fallback", () => {
    const ref = parseCaseRef("２０２６-０９-０５-手机购买调研");
    expect(ref).toEqual({
      kind: "legacy",
      name: "２０２６-０９-０５-手机购买调研",
    });
    const paths = resolveCaseRefPaths(ref!);
    // Every exact candidate precedes every folded one.
    const exact = paths.filter((p) => p.includes("２０２６"));
    const folded = paths.filter((p) => p.includes("2026-09-05"));
    expect(exact.length).toBeGreaterThan(0);
    expect(folded.length).toBeGreaterThan(0);
    expect(paths.indexOf(exact[exact.length - 1])).toBeLessThan(
      paths.indexOf(folded[0]),
    );
    expect(folded).toContain("memory/docs/topic/2026-09-05-手机购买调研.md");
  });
});
