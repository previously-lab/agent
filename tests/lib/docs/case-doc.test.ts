import { describe, it, expect, beforeEach } from "vitest";
import {
  parseCaseDoc,
  serializeCaseDoc,
  createCase,
  createDoc,
  rewriteBody,
  closeDoc,
  appendTail,
  type CaseDoc,
} from "@/lib/docs";

const PIECE = {
  category: "research" as const,
  caseName: "手机购买调研",
  fileName: "2026-09-05-手机购买调研.md",
};

const SEALED_RAW = `---
opened: '2026-09-05'
closed: '2026-10-02'
---

调研结论：买 16 Pro。证据见切片 2026-09-12-0930。

—— 尾部 ——
2026-10-02：封口。结论如上。
2026-11-09：价格已过时，最新见报价篇。
`;

describe("parseCaseDoc — new format", () => {
  it("parses a sealed doc fully", () => {
    const doc = parseCaseDoc(SEALED_RAW, PIECE);
    expect(doc.warnings).toEqual([]);
    expect(doc.opened).toBe("2026-09-05");
    expect(doc.closed).toBe("2026-10-02");
    expect(doc.body).toContain("买 16 Pro");
    expect(doc.tail).toEqual([
      { date: "2026-10-02", text: "封口。结论如上。" },
      { date: "2026-11-09", text: "价格已过时，最新见报价篇。" },
    ]);
  });

  it("treats absent closed as 还在写", () => {
    const raw = `---
opened: '2026-09-05'
---

草稿正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBeNull();
    expect(doc.tail).toEqual([]);
  });

  it("UNQUOTED YAML dates: closed/opened arrive as Date objects and survive", () => {
    // `closed: 2026-10-02` (no quotes) is the most natural hand/model write —
    // js-yaml parses it as a Date. Dropping it would read a SEALED doc as
    // 还在写. Both fields must normalize to YYYY-MM-DD strings.
    const raw = `---
opened: 2026-09-05
closed: 2026-10-02
---

正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBe("2026-10-02");
    expect(doc.opened).toBe("2026-09-05");
    expect(doc.warnings).toEqual([]);
  });

  it("unquoted opened on index.md normalizes too", () => {
    const raw = `---
opened: 2026-08-01
---

index 正文。
`;
    const doc = parseCaseDoc(raw, {
      category: "people",
      caseName: "user",
      fileName: "index.md",
    });
    expect(doc.opened).toBe("2026-08-01");
    expect(doc.warnings).toEqual([]);
  });

  it("a garbage closed value warns and reads as 还在写 — no crash", () => {
    const raw = `---
opened: '2026-09-05'
closed: 昨天的
---

正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBeNull();
    expect(doc.warnings.some((w) => w.includes("closed"))).toBe(true);
    expect(doc.body).toContain("正文");
  });

  it("date-looking lines in the body are NOT tail without the marker", () => {
    const raw = `---
opened: '2026-09-05'
---

正文里有一句 2026-10-02：这不是尾部。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.body).toContain("2026-10-02：这不是尾部");
    expect(doc.tail).toEqual([]);
  });

  it("index.md takes opened from the header (no name date to disagree)", () => {
    const raw = `---
opened: '2026-08-01'
---

这是 user case 的 index。
`;
    const doc = parseCaseDoc(raw, {
      category: "people",
      caseName: "user",
      fileName: "index.md",
    });
    expect(doc.opened).toBe("2026-08-01");
    expect(doc.warnings).toEqual([]);
  });

  it("missing opened on index.md warns but opens", () => {
    const doc = parseCaseDoc("没有头部。\n", {
      category: "self",
      caseName: "search",
      fileName: "index.md",
    });
    expect(doc.warnings.some((w) => w.includes("opened"))).toBe(true);
  });
});

describe("same-source rule", () => {
  it("header/name mismatch → warning, NAME wins", () => {
    const raw = `---
opened: '2026-09-09'
---

正文。
`;
    const doc = parseCaseDoc(raw, PIECE); // name says 2026-09-05
    expect(doc.opened).toBe("2026-09-05");
    expect(doc.warnings.some((w) => w.includes("不一致") && w.includes("以篇名为准"))).toBe(
      true,
    );
  });

  it("absent header opened on a piece is filled from the name silently", () => {
    const doc = parseCaseDoc("正文。\n", PIECE);
    expect(doc.opened).toBe("2026-09-05");
    expect(doc.warnings.some((w) => w.includes("不一致"))).toBe(false);
  });
});

describe("legacy tolerance (v0.15 three-field header)", () => {
  it("status: active maps to unsealed, 截至块 promoted to body", () => {
    const raw = `---
status: active
opened: '2026-09-05'
updated: '2026-09-12'
---
# 关于手机购买的调研

> 截至 2026-09-12：倾向 16 Pro，等双 11。

## 2026-09-05 — 开篇

想换手机。预算六千以内。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBeNull();
    expect(doc.opened).toBe("2026-09-05"); // name wins over header
    expect(doc.body).toContain("截至 2026-09-12：倾向 16 Pro");
    expect(doc.warnings.some((w) => w.includes("status"))).toBe(true);
    expect(doc.warnings.some((w) => w.includes("updated"))).toBe(true);
    // the legacy entry stream survives verbatim
    expect(doc.preserved).toContain("## 2026-09-05 — 开篇");
    expect(doc.preserved).toContain("预算六千以内");
  });

  it("status: closed maps to closed: <updated> with a warning", () => {
    const raw = `---
status: closed
opened: '2026-09-05'
updated: '2026-09-20'
---
> 截至 2026-09-20：结案。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBe("2026-09-20");
    expect(doc.warnings.some((w) => w.includes("status: closed"))).toBe(true);
  });

  it("status: void also maps to a seal date (supersession prose stays in the stream)", () => {
    const raw = `---
status: void
opened: '2026-09-05'
updated: '2026-09-25'
---
> 截至 2026-09-25：作废，见新篇。

## 2026-09-25 — 作废
被《2026-09-25-新调研》取代。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBe("2026-09-25");
    expect(doc.preserved).toContain("作废");
  });

  it("never throws on garbage; a broken frontmatter block warns", () => {
    // no header at all is legal for a piece (the name supplies opened) —
    // the throw-risk is a malformed frontmatter block:
    const doc = parseCaseDoc("---\nopened: 'unclosed\n---\n正文\n", PIECE);
    expect(doc.warnings.length).toBeGreaterThan(0);
    expect(doc.body).toContain("正文");
  });
});

describe("serializeCaseDoc round-trip", () => {
  it("preserves substance through a full cycle", () => {
    const doc = parseCaseDoc(SEALED_RAW, PIECE);
    const again = parseCaseDoc(serializeCaseDoc(doc), PIECE);
    expect(again.warnings).toEqual([]);
    expect(again.opened).toBe(doc.opened);
    expect(again.closed).toBe(doc.closed);
    expect(again.body).toBe(doc.body);
    expect(again.tail).toEqual(doc.tail);
  });

  it("emits only opened/closed — legacy fields are dropped", () => {
    const doc = parseCaseDoc(
      "---\nstatus: closed\nopened: '2026-09-05'\nupdated: '2026-09-20'\n---\n> 截至 2026-09-20：x。\n",
      PIECE,
    );
    const out = serializeCaseDoc(doc);
    expect(out).not.toContain("status:");
    expect(out).not.toContain("updated:");
    expect(out).toContain("closed: '2026-09-20'");
  });
});

describe("the five ops — matrix enforcement", () => {
  let living: CaseDoc;
  beforeEach(() => {
    living = createCase({
      category: "people",
      caseName: "user",
      opened: "2026-09-05",
      body: "初始正文。",
    });
  });

  it("createCase seeds an unsealed index doc", () => {
    expect(living.fileName).toBe("index.md");
    expect(living.opened).toBe("2026-09-05");
    expect(living.closed).toBeNull();
    expect(living.body).toBe("初始正文。");
  });

  it("createDoc fills opened from the piece name (same-source, structural)", () => {
    const piece = createDoc({
      category: "research",
      caseName: "手机购买调研",
      date: "2026-09-08",
      title: "报价篇",
      body: "三家报价。",
    });
    expect(piece.fileName).toBe("2026-09-08-报价篇.md");
    expect(piece.opened).toBe("2026-09-08");
  });

  it("createDoc rejects a red-line title", () => {
    expect(() =>
      createDoc({
        category: "research",
        caseName: "x",
        date: "2026-09-08",
        title: "2025年计划",
        body: "",
      }),
    ).toThrow();
  });

  it("rewriteBody works while living and does NOT archive the old draft", () => {
    const next = rewriteBody(living, "全新正文。");
    expect(next.body).toBe("全新正文。");
    // draft semantics: old draft is gone, no archive anywhere
    expect(next.tail).toEqual([]);
    expect(next.preserved).toBe("");
    expect(living.body).toBe("初始正文。"); // pure
  });

  it("rewriteBody on a sealed doc THROWS", () => {
    const sealed = closeDoc(living, { date: "2026-10-02", note: "封口。" });
    expect(() => rewriteBody(sealed, "改")).toThrow();
  });

  it("appendTail on a living doc THROWS", () => {
    expect(() => appendTail(living, { date: "2026-10-03", text: "补充" })).toThrow();
  });

  it("closeDoc lands closed + the closing line in the same op", () => {
    const sealed = closeDoc(living, { date: "2026-10-02", note: "封口。结论如上。" });
    expect(sealed.closed).toBe("2026-10-02");
    expect(sealed.tail).toEqual([{ date: "2026-10-02", text: "封口。结论如上。" }]);
    // and the two halves are born together: the header round-trips with the line
    const again = parseCaseDoc(serializeCaseDoc(sealed), {
      category: "people",
      caseName: "user",
      fileName: "index.md",
    });
    expect(again.closed).toBe("2026-10-02");
    expect(again.tail).toHaveLength(1);
  });

  it("closeDoc on a sealed doc THROWS; double-tail after sealing is fine", () => {
    const sealed = closeDoc(living, { date: "2026-10-02", note: "封口。" });
    expect(() => closeDoc(sealed, { date: "2026-10-03", note: "再封" })).toThrow();
    const withNote = appendTail(sealed, { date: "2026-11-01", text: "补充一行。" });
    expect(withNote.tail).toHaveLength(2);
    expect(withNote.body).toBe(sealed.body); // body untouched
  });

  it("closeDoc rejects empty note and bad dates", () => {
    expect(() => closeDoc(living, { date: "2026-10-02", note: "  " })).toThrow();
    expect(() => closeDoc(living, { date: "2026-13-40", note: "x" })).toThrow();
  });
});
