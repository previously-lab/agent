/**
 * The reference tokenizer (v0.22 §7): what lights up on a paper, and — the
 * point of this file — what never does. The grammar's four candidate forms
 * are the positives; ordinary prose (numbers, dates, times, file paths,
 * bare slice ids, code) are the negatives, and a citation that fails the
 * naming red line is not a ref at all.
 */
import { describe, expect, it } from "vitest";

import {
  extractMarkdownRefs,
  tokenizeRefText,
} from "@/lib/archive/ref-tokens";

function refs(text: string): string[] {
  return tokenizeRefText(text).map((t) => t.ref);
}

describe("tokenizeRefText — case and piece refs", () => {
  it("finds a case ref and a piece ref in prose", () => {
    expect(refs("详见 research/手机调研 的结论。")).toEqual(["research/手机调研"]);
    expect(refs("见 research/手机调研/2026-09-08-报价篇。")).toEqual([
      "research/手机调研/2026-09-08-报价篇",
    ]);
  });

  it("accepts every category and dated case names", () => {
    expect(refs("people/陈勇超")).toEqual(["people/陈勇超"]);
    expect(refs("events/2026-11-05-发布会")).toEqual(["events/2026-11-05-发布会"]);
    expect(refs("self/search")).toEqual(["self/search"]);
  });

  it("stops the match at sentence punctuation, both widths", () => {
    expect(refs("（research/手机调研）里")).toEqual(["research/手机调研"]);
    expect(refs("research/手机调研，再谈")).toEqual(["research/手机调研"]);
    expect(refs("research/手机调研.md")).toEqual(["research/手机调研"]);
  });

  it("falls back to the case form when the third segment is no piece", () => {
    // 报价篇 is not a dated piece name — the citation reads as the case.
    expect(refs("research/手机调研/报价篇")).toEqual(["research/手机调研"]);
  });

  it("refuses illegal names and unknown categories entirely", () => {
    expect(refs("research/")).toEqual([]);
    expect(refs("research/2026-11-05-1430")).toEqual([]); // the red line
    expect(refs("unknown/手机调研")).toEqual([]);
    expect(refs("records/手机调研")).toEqual([]);
    // A path into a category is prose about a path, not a citation.
    expect(refs("memory/research/手机调研")).toEqual([]);
    expect(refs("myresearch/手机调研")).toEqual([]);
  });
});

describe("tokenizeRefText — records and dossier refs", () => {
  it("finds the two non-case vocabularies", () => {
    expect(refs("records/2026-10-05-1430")).toEqual(["records/2026-10-05-1430"]);
    expect(refs("dossier/previously 和 dossier/direction")).toEqual([
      "dossier/previously",
      "dossier/direction",
    ]);
  });

  it("refuses malformed record ids and unknown dossier documents", () => {
    expect(refs("records/2026-10-5-1430")).toEqual([]);
    expect(refs("records/2026-10-05-14300")).toEqual([]);
    expect(refs("records/2026-10-05-1430/extra")).toEqual([]);
    expect(refs("records/../CHARTER")).toEqual([]);
    expect(refs("myrecords/2026-10-05-1430")).toEqual([]);
    expect(refs("dossier/charter")).toEqual([]);
    expect(refs("dossier/")).toEqual([]);
  });
});

describe("tokenizeRefText — evidence stamps", () => {
  it("harvests the slice ids inside (refs: …), both paren widths", () => {
    expect(refs("第一行 (refs: 2026-08-09-0746)")).toEqual([
      "records/2026-08-09-0746",
    ]);
    expect(refs("（refs: 2026-08-09-0746, 2026-08-10-0912）")).toEqual([
      "records/2026-08-09-0746",
      "records/2026-08-10-0912",
    ]);
  });

  it("harvests the evolution tail's — refs: form to end of line", () => {
    const text = "用户的模式 — refs: 2026-08-09-0746, 2026-08-10-0912\n下一行";
    expect(refs(text)).toEqual([
      "records/2026-08-09-0746",
      "records/2026-08-10-0912",
    ]);
  });

  it("links the id's own span, leaving the stamp punctuation plain", () => {
    const text = "(refs: 2026-08-09-0746)";
    const [t] = tokenizeRefText(text);
    expect(text.slice(t.start, t.end)).toBe("2026-08-09-0746");
  });

  it("ignores stamps without slice ids and prefers: prose", () => {
    expect(refs("(refs: 无)")).toEqual([]);
    expect(refs("he prefers: 2026-08-09-0746 stay")).toEqual([]);
  });
});

describe("tokenizeRefText — the negatives (ordinary prose never lights up)", () => {
  it("bare slice ids outside a stamp are prose, not citations", () => {
    expect(refs("2026-08-09-0746 那天聊了很多")).toEqual([]);
  });

  it("numbers, dates and times are prose", () => {
    expect(refs("2026-08-09 14:30, 3.5 小时, 42 页")).toEqual([]);
    expect(refs("第 1024 次")).toEqual([]);
  });

  it("file-ish words and paths stay plain", () => {
    expect(refs("src/lib/archive/refs.ts")).toEqual([]);
    expect(refs("打开 index.md 或 README")).toEqual([]);
    expect(refs("docs/research-notes.md")).toEqual([]);
  });

  it("code spans and fenced code carry no candidates", () => {
    const md = [
      "见 `records/2026-08-09-0746` 的输出",
      "```",
      "research/手机调研",
      "(refs: 2026-08-09-0746)",
      "```",
      "正文 research/真实案例",
    ].join("\n");
    expect(extractMarkdownRefs(md)).toEqual(["research/真实案例"]);
  });
});

describe("extractMarkdownRefs", () => {
  it("dedupes in first-appearance order across the whole document", () => {
    const md = [
      "研究见 research/手机调研，记录 records/2026-08-09-0746。",
      "再引 research/手机调研 一次。",
      "",
      "(refs: 2026-08-09-0746)",
    ].join("\n");
    expect(extractMarkdownRefs(md)).toEqual([
      "research/手机调研",
      "records/2026-08-09-0746",
    ]);
  });
});
