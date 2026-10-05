import { describe, it, expect, beforeEach } from "vitest";
import {
  parseCaseDoc,
  serializeCaseDoc,
  createCase,
  createDoc,
  rewriteBody,
  appendTail,
  type CaseDoc,
} from "@/lib/docs";

const PIECE = {
  category: "research" as const,
  caseName: "手机购买调研",
  fileName: "2026-09-05-手机购买调研.md",
};

/** A HISTORICAL sealed doc (pre-v0.21): `closed` is retired but parse-tolerated. */
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
  it("parses a historical sealed doc fully (closed tolerated, inert)", () => {
    const doc = parseCaseDoc(SEALED_RAW, PIECE);
    expect(doc.warnings).toEqual([]);
    expect(doc.opened).toBe("2026-09-05");
    expect(doc.closed).toBe("2026-10-02"); // history, surfaced verbatim
    // No `updated` on a pre-window doc — resolves to the birth date silently.
    expect(doc.updated).toBe("2026-09-05");
    expect(doc.body).toContain("买 16 Pro");
    expect(doc.tail).toEqual([
      { date: "2026-10-02", text: "封口。结论如上。" },
      { date: "2026-11-09", text: "价格已过时，最新见报价篇。" },
    ]);
  });

  it("treats absent closed as-is (null) — sealing is the window now, not a field", () => {
    const raw = `---
opened: '2026-09-05'
---

草稿正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBeNull();
    expect(doc.tail).toEqual([]);
  });

  it("the updated stamp keeps its TIME OF DAY (the window measures minutes)", () => {
    const raw = `---
opened: '2026-09-05'
updated: '2026-09-05T13:22:10.000Z'
---

正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.updated).toBe("2026-09-05T13:22:10.000Z");
    expect(doc.warnings).toEqual([]);
  });

  it("UNQUOTED ISO timestamps arrive as Date objects and survive untruncated", () => {
    // js-yaml parses an unquoted ISO timestamp as a Date — truncating it to
    // YYYY-MM-DD would silently pin the write window to midnight.
    const raw = `---
opened: 2026-09-05
updated: 2026-09-05T13:22:10.000Z
closed: 2026-10-02
---

正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.opened).toBe("2026-09-05");
    expect(doc.updated).toBe("2026-09-05T13:22:10.000Z");
    expect(doc.closed).toBe("2026-10-02");
    expect(doc.warnings).toEqual([]);
  });

  it("a garbage updated value warns and falls back to opened — no crash", () => {
    const raw = `---
opened: '2026-09-05'
updated: 刚才
---

正文。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.updated).toBe("2026-09-05");
    expect(doc.warnings.some((w) => w.includes("updated"))).toBe(true);
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

  it("a garbage closed value warns and reads as absent — no crash", () => {
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
  it("status: active is ignored; the legacy date-only updated parses first-class", () => {
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
    expect(doc.updated).toBe("2026-09-12"); // the legacy stamp is the anchor now
    expect(doc.body).toContain("截至 2026-09-12：倾向 16 Pro");
    expect(doc.warnings.some((w) => w.includes("status"))).toBe(true);
    // the legacy entry stream survives verbatim
    expect(doc.preserved).toContain("## 2026-09-05 — 开篇");
    expect(doc.preserved).toContain("预算六千以内");
  });

  it("status: closed maps to a historical closed: <updated> with a warning", () => {
    const raw = `---
status: closed
opened: '2026-09-05'
updated: '2026-09-20'
---
> 截至 2026-09-20：结案。
`;
    const doc = parseCaseDoc(raw, PIECE);
    expect(doc.closed).toBe("2026-09-20");
    expect(doc.updated).toBe("2026-09-20");
    expect(doc.warnings.some((w) => w.includes("status: closed"))).toBe(true);
  });

  it("status: void also maps to a historical seal date (supersession prose stays in the stream)", () => {
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
  it("preserves substance through a full cycle (historical closed round-trips)", () => {
    const doc = parseCaseDoc(SEALED_RAW, PIECE);
    const again = parseCaseDoc(serializeCaseDoc(doc), PIECE);
    expect(again.warnings).toEqual([]);
    expect(again.opened).toBe(doc.opened);
    expect(again.updated).toBe(doc.updated);
    expect(again.closed).toBe(doc.closed);
    expect(again.body).toBe(doc.body);
    expect(again.tail).toEqual(doc.tail);
  });

  it("drops legacy status; updated is emitted first-class", () => {
    const doc = parseCaseDoc(
      "---\nstatus: closed\nopened: '2026-09-05'\nupdated: '2026-09-20'\n---\n> 截至 2026-09-20：x。\n",
      PIECE,
    );
    const out = serializeCaseDoc(doc);
    expect(out).not.toContain("status:");
    expect(out).toContain("updated: '2026-09-20'");
    expect(out).toContain("closed: '2026-09-20'"); // historical, round-tripped
  });
});

describe("the write ops — pure, clock-free (time guards live in the write entry)", () => {
  let living: CaseDoc;
  beforeEach(() => {
    living = createCase({
      category: "people",
      caseName: "user",
      opened: "2026-09-05",
      body: "初始正文。",
    });
  });

  it("createCase seeds an index doc with updated = the birth date", () => {
    expect(living.fileName).toBe("index.md");
    expect(living.opened).toBe("2026-09-05");
    expect(living.updated).toBe("2026-09-05");
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
    expect(piece.updated).toBe("2026-09-08");
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

  it("rewriteBody replaces the 正文 and does NOT archive the old draft", () => {
    const next = rewriteBody(living, "全新正文。");
    expect(next.body).toBe("全新正文。");
    // draft semantics: old draft is gone, no archive anywhere
    expect(next.tail).toEqual([]);
    expect(next.preserved).toBe("");
    expect(living.body).toBe("初始正文。"); // pure
  });

  it("rewriteBody is unconditional at the op level — the window guard is the write entry's", () => {
    // A doc carrying a historical closed date: the pure op does not consult
    // it (sealing is retired); whether a rewrite may LAND is decided by the
    // write entry's window check (tested in librarian.test.ts).
    const historical = parseCaseDoc(SEALED_RAW, PIECE);
    const next = rewriteBody(historical, "重写。");
    expect(next.body).toBe("重写。");
    expect(next.closed).toBe("2026-10-02"); // history carried along, inert
  });

  it("appendTail is always allowed — window or not, sealed history or not", () => {
    const draft = appendTail(living, { date: "2026-10-03", text: "补充" });
    expect(draft.tail).toEqual([{ date: "2026-10-03", text: "补充" }]);
    const historical = parseCaseDoc(SEALED_RAW, PIECE);
    const again = appendTail(historical, { date: "2026-11-10", text: "再补一行。" });
    expect(again.tail).toHaveLength(3);
    expect(again.body).toBe(historical.body); // body untouched
  });

  it("appendTail rejects empty text and bad dates", () => {
    expect(() => appendTail(living, { date: "2026-10-03", text: "  " })).toThrow();
    expect(() => appendTail(living, { date: "2026-13-40", text: "x" })).toThrow();
  });
});
