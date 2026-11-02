import { describe, expect, it } from "vitest";
import { caseOpeningBody, casePieceCatalog, casePieceNavigation, renderCasePieceCatalog } from "@/lib/docs/organization";
import { parseDocumentLink } from "@/lib/documents/document-link";

const home = { category: "research" as const, caseName: "工作灯", date: "2026-10-02" };

describe("case reading homes", () => {
  it("lists exact scoped identities without treating inventory membership as a read", () => {
    const first = "memory/research/工作灯/2026-10-01-摆位：小桌.md";
    const second = "memory/research/工作灯/2026-10-02-供电（试验）.md";
    const ref = "research/工作灯/2026-10-01-摆位：小桌";
    const catalog = casePieceCatalog({ ...home, paths: [second, first, first, "memory/research/别案/2026-10-01-别篇.md", "memory/research/工作灯/_current.md", "memory/research/工作灯/sub/2026-10-01-嵌套.md"], readRefs: new Set([ref]) });
    expect(catalog).toEqual([
      { ref, title: "摆位：小桌", date: "2026-10-01", read: true },
      { ref: "research/工作灯/2026-10-02-供电（试验）", title: "供电（试验）", date: "2026-10-02", read: false },
    ]);
    expect(renderCasePieceCatalog(catalog)).toContain("UNREAD in this run");
    expect(casePieceCatalog({ ...home, paths: [first] })?.[0].read).toBe(false);
    expect(renderCasePieceCatalog(casePieceCatalog({ ...home, paths: null }))).toContain("unavailable");
    expect(renderCasePieceCatalog([])).toContain("no dated pieces listed");
  });

  it("uses navigable canonical refs even with spaces, parentheses and brackets", () => {
    const nav = casePieceNavigation({ ...home, title: "供电 [方案] (小灯)" });
    const href = /\]\((.+)\)$/.exec(nav.line)?.[1];
    expect(parseDocumentLink(href)?.ref).toBe(nav.ref);
    expect(nav.line).toContain("\\[方案\\]");
    expect(() => casePieceNavigation({ ...home, title: "../别篇" })).toThrow();
  });

  it("opens with a distinct overview and a link rather than duplicating the first piece", () => {
    const body = "试验步骤。\n\n```text\n  保留缩进\n第二行\n```";
    const options = { ...home, body, pieceTitle: "供电试验" };
    expect(() => caseOpeningBody(options)).toThrow("overviewBody");
    expect(() => caseOpeningBody({ ...options, overviewBody: ` ${body} ` })).toThrow("distinct");
    const overview = caseOpeningBody({ ...options, overviewBody: "比较工作灯的供电方案。" });
    expect(overview).not.toContain("试验步骤");
    expect(overview).toContain(casePieceNavigation({ ...home, title: options.pieceTitle }).line);
    expect(caseOpeningBody({ ...options, overviewBody: overview })).toBe(overview);
    expect(caseOpeningBody({ ...home, body })).toBe(body);
  });
});
