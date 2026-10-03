import { describe, it, expect } from "vitest";
import {
  parseDoc,
  serializeDoc,
  createDocSkeleton,
  appendEntry,
  rewriteAsOf,
  markStatus,
  type ParsedDoc,
} from "@/lib/docs";

const FULL_DOC = `---
status: active
opened: '2026-09-05'
updated: '2026-09-12'
---
# 关于手机购买的调研

> 截至 2026-09-12：倾向 16 Pro，等双 11。

## 2026-09-05 — 开篇

想换手机。预算六千以内。

## 2026-09-12 — 更新

看完评测，锁定两款。《2026-09-05-备选清单》里有对比。
`;

function parseFull(): ParsedDoc {
  return parseDoc(FULL_DOC, "2026-09-05-手机购买调研.md", "research");
}

describe("parseDoc", () => {
  it("parses a well-formed document fully", () => {
    const doc = parseFull();
    expect(doc.warnings).toEqual([]);
    expect(doc.frontmatter).toEqual({
      status: "active",
      opened: "2026-09-05",
      updated: "2026-09-12",
    });
    expect(doc.heading).toBe("关于手机购买的调研");
    expect(doc.asOf).toEqual({
      date: "2026-09-12",
      text: "倾向 16 Pro，等双 11。",
    });
    expect(doc.sections).toHaveLength(2);
    const [a, b] = doc.sections;
    expect(a.type).toBe("entry");
    if (a.type === "entry") {
      expect(a.entry.date).toBe("2026-09-05");
      expect(a.entry.title).toBe("开篇");
      expect(a.entry.body).toContain("想换手机");
    }
    if (b.type === "entry") {
      expect(b.entry.title).toBe("更新");
      expect(b.entry.body).toContain("备选清单");
    }
  });

  it("is tolerant of a broken file — never throws, always warns", () => {
    const broken = `---
status: archived
opened: not-a-date
unknown_field: 42
---
# 标题

这段散文不属于任何条目。

## 不是日期的条目头
坏条目内容。
`;
    const doc = parseDoc(broken, "2020-01-01-x.md", "research");
    expect(doc.frontmatter.status).toBe("active"); // illegal → warned + defaulted
    expect(doc.frontmatter.opened).toBe("not-a-date"); // kept, not lost
    expect(doc.warnings.join(" ")).toContain("status");
    expect(doc.warnings.join(" ")).toContain("opened");
    expect(doc.warnings.join(" ")).toContain("unknown_field");
    expect(doc.warnings.join(" ")).toContain("条目头无法解析");
    // unrecognized bytes survive in a raw section
    const raw = doc.sections.find((s) => s.type === "raw");
    expect(raw).toBeDefined();
    if (raw?.type === "raw") expect(raw.text).toContain("坏条目内容");
  });

  it("parses a file with no frontmatter at all", () => {
    const doc = parseDoc("## 2026-09-05 — 开篇\n\n只有正文。\n", "2026-09-05-x.md", "task");
    expect(doc.frontmatter.status).toBe("active");
    expect(doc.warnings.some((w) => w.includes("opened"))).toBe(true);
    expect(doc.sections).toHaveLength(1);
  });

  it("keeps a multi-line 截至块", () => {
    const raw = `---
status: active
opened: '2026-09-05'
updated: '2026-09-05'
---
> 截至 2026-09-05：第一行。
> 第二行补充。

## 2026-09-05 — 开篇
正文。
`;
    const doc = parseDoc(raw, "2026-09-05-x.md", "task");
    expect(doc.asOf?.text).toBe("第一行。\n第二行补充。");
  });
});

describe("serializeDoc / parseDoc round-trip", () => {
  it("preserves substance through a full cycle", () => {
    const doc = parseFull();
    const again = parseDoc(serializeDoc(doc), doc.fileName, doc.kind);
    expect(again.warnings).toEqual([]);
    expect(again.frontmatter).toEqual(doc.frontmatter);
    expect(again.heading).toBe(doc.heading);
    expect(again.asOf).toEqual(doc.asOf);
    expect(again.sections).toEqual(doc.sections);
  });

  it("round-trips a broken doc without losing the unrecognized bytes", () => {
    const broken = `---
status: active
opened: '2026-09-05'
updated: '2026-09-05'
---
## 2026-09-05 — 开篇
好条目。

## 奇怪头
存活文本。
`;
    const doc = parseDoc(broken, "2026-09-05-x.md", "task");
    const again = parseDoc(serializeDoc(doc), doc.fileName, doc.kind);
    const raw = again.sections.find((s) => s.type === "raw");
    expect(raw?.type === "raw" && raw.text).toContain("存活文本");
    expect(again.sections.filter((s) => s.type === "entry")).toHaveLength(1);
  });

  it("emits exactly the three machine frontmatter fields", () => {
    const raw = `---
status: active
opened: '2026-09-05'
updated: '2026-09-05'
junk: 1
---
## 2026-09-05 — 开篇
x
`;
    const out = serializeDoc(parseDoc(raw, "2026-09-05-x.md", "task"));
    expect(out).toContain("status:");
    expect(out).toContain("opened:");
    expect(out).toContain("updated:");
    expect(out).not.toContain("junk:");
  });
});

describe("appendEntry", () => {
  it("appends without touching existing entries (pure)", () => {
    const doc = parseFull();
    const next = appendEntry(doc, {
      date: "2026-09-20",
      title: "用户更正",
      body: "用户说其实预算八千。",
    });
    // original untouched
    expect(doc.sections).toHaveLength(2);
    expect(doc.frontmatter.updated).toBe("2026-09-12");
    // new entry at the end, restamped
    expect(next.sections).toHaveLength(3);
    const last = next.sections[2];
    expect(last.type === "entry" && last.entry.title).toBe("用户更正");
    expect(next.frontmatter.updated).toBe("2026-09-20");
    // round-trips
    const again = parseDoc(serializeDoc(next), next.fileName, next.kind);
    expect(again.sections).toEqual(next.sections);
  });

  it("rejects bad dates and empty titles", () => {
    const doc = parseFull();
    expect(() => appendEntry(doc, { date: "2026-13-01", title: "x", body: "" })).toThrow();
    expect(() => appendEntry(doc, { date: "2026-09-20", title: "  ", body: "" })).toThrow();
  });
});

describe("rewriteAsOf", () => {
  it("replaces the 截至块 and restamps updated, entries untouched", () => {
    const doc = parseFull();
    const next = rewriteAsOf(doc, { date: "2026-09-20", text: "已下单 16 Pro。" });
    expect(doc.asOf?.text).toContain("倾向 16 Pro"); // original untouched
    expect(next.asOf).toEqual({ date: "2026-09-20", text: "已下单 16 Pro。" });
    expect(next.sections).toEqual(doc.sections);
    expect(next.frontmatter.updated).toBe("2026-09-20");
  });

  it("creates a 截至块 on a doc that had none", () => {
    let doc = createDocSkeleton({
      fileName: "2026-09-05-x.md",
      kind: "task",
      opened: "2026-09-05",
    });
    doc = appendEntry(doc, { date: "2026-09-05", title: "开篇", body: "body" });
    expect(doc.asOf).toBeNull();
    const next = rewriteAsOf(doc, { date: "2026-09-05", text: "现状" });
    expect(next.asOf).not.toBeNull();
    const again = parseDoc(serializeDoc(next), next.fileName, next.kind);
    expect(again.asOf).toEqual(next.asOf);
    // as-of sits before the entry in the emitted text
    expect(serializeDoc(next).indexOf("截至")).toBeLessThan(
      serializeDoc(next).indexOf("## 2026-09-05"),
    );
  });
});

describe("markStatus", () => {
  it("closes a doc with a dated stamp", () => {
    const doc = parseFull();
    const next = markStatus(doc, "closed", "2026-09-20");
    expect(next.frontmatter.status).toBe("closed");
    expect(next.frontmatter.updated).toBe("2026-09-20");
    expect(doc.frontmatter.status).toBe("active");
  });

  it("void requires a dated 作废 entry in the stream", () => {
    const doc = parseFull();
    expect(() => markStatus(doc, "void", "2026-09-20")).toThrow();
    const withVoid = appendEntry(doc, {
      date: "2026-09-20",
      title: "作废",
      body: "被《2026-09-20-新调研》取代。",
    });
    const next = markStatus(withVoid, "void", "2026-09-20");
    expect(next.frontmatter.status).toBe("void");
  });
});

describe("createDocSkeleton", () => {
  it("seeds an active doc with updated = opened", () => {
    const doc = createDocSkeleton({
      fileName: "2026-09-05-某调研.md",
      kind: "research",
      opened: "2026-09-05",
      heading: "某调研",
    });
    expect(doc.frontmatter).toEqual({
      status: "active",
      opened: "2026-09-05",
      updated: "2026-09-05",
    });
    expect(doc.sections).toEqual([]);
  });

  it("rejects an illegal opened date", () => {
    expect(() =>
      createDocSkeleton({ fileName: "x.md", kind: "topic", opened: "bad" }),
    ).toThrow();
  });
});
