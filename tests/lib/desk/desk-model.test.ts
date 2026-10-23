/**
 * The document desk's pure decisions (v0.22 P1): the paper's view model
 * (title / case ref / category / the dead-link "not found" call) and the
 * provider's open-desk panel fold.
 * The repo's vitest env is node (no component rendering), so everything the
 * desk decides lives here in React-free functions and is covered directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clampPage,
  deskPaperModel,
  mastheadLines,
  pageForShellSlot,
  panelModeForDeskOpen,
  SHELL_COUNT,
  shellOffsetForSlot,
  wrapPage,
} from "@/components/desk/desk-model";
import type { CaseDocContent } from "@/lib/episodic/actions";

function doc(markdown: string, opened = "2026-09-05"): CaseDocContent {
  return { ref: "unused", opened, closed: null, markdown, warnings: [] };
}

describe("deskPaperModel", () => {
  it("derives the case paper: title, header ref, category, verbatim date", () => {
    const model = deskPaperModel("research/手机调研", doc("# 正文", "2026-09-01"));
    expect(model.title).toBe("手机调研");
    expect(model.caseRef).toBe("research / 手机调研");
    expect(model.category).toBe("research");
    expect(model.date).toBe("2026-09-01");
    expect(model.markdown).toBe("# 正文");
  });

  it("derives the piece paper: the piece name (`.md` stripped) is the title", () => {
    const model = deskPaperModel(
      "people/手机/2026-09-08-报价篇.md",
      doc("报价对比"),
    );
    expect(model.title).toBe("2026-09-08-报价篇");
    expect(model.caseRef).toBe("people / 手机");
    expect(model.category).toBe("people");
  });

  it("a legacy ref names no case: no header ref and no footer category", () => {
    const model = deskPaperModel("用户手机", doc("旧文档"));
    expect(model.title).toBe("用户手机");
    expect(model.caseRef).toBeNull();
    expect(model.category).toBeNull();
    expect(model.markdown).toBe("旧文档");
  });

  it("strips 《》 citation marks before deriving anything", () => {
    const model = deskPaperModel("《research/手机调研》", doc("x"));
    expect(model.title).toBe("手机调研");
    expect(model.caseRef).toBe("research / 手机调研");
  });

  it("THE NOT-FOUND DECISION: a null document is the dead-link paper, with the header still derivable", () => {
    const model = deskPaperModel("research/不存在的调研", null);
    expect(model.markdown).toBeNull();
    expect(model.title).toBe("不存在的调研");
    expect(model.caseRef).toBe("research / 不存在的调研");
    expect(model.category).toBe("research");
    expect(model.date).toBe("");
  });

  it("an empty body is NOT a dead link — the paper still prints", () => {
    expect(deskPaperModel("research/手机调研", doc("")).markdown).toBe("");
  });

  it("a record ref is the transcript paper: no title, slice id as the header ref", () => {
    const model = deskPaperModel("records/2026-10-05-1430", {
      ...doc("**You**\n\nhello", "2026-10-05"),
      turnCount: 12,
      timezone: "Asia/Shanghai",
    });
    expect(model.kind).toBe("record");
    expect(model.title).toBe("");
    expect(model.caseRef).toBe("2026-10-05-1430");
    expect(model.date).toBe("2026-10-05");
    expect(model.category).toBeNull();
    expect(model.turnCount).toBe(12);
    expect(model.timezone).toBe("Asia/Shanghai");
  });

  it("the record branch routes BEFORE the case grammar — the slice id would otherwise parse as a legacy name", () => {
    expect(deskPaperModel("records/2026-10-05-1430", null).kind).toBe("record");
  });

  it("a dead record ref still prints the not-found paper, header intact", () => {
    const model = deskPaperModel("records/2026-10-05-1430", null);
    expect(model.markdown).toBeNull();
    expect(model.caseRef).toBe("2026-10-05-1430");
    expect(model.turnCount).toBeNull();
  });

  it("a dossier ref is a self-document paper: named, no case furniture", () => {
    const model = deskPaperModel("dossier/previously", doc("# Previously on"));
    expect(model.kind).toBe("dossier");
    expect(model.dossier).toBe("previously");
    expect(model.title).toBe("previously");
    expect(model.caseRef).toBeNull();
    expect(model.category).toBeNull();
    expect(model.turnCount).toBeNull();
  });
});

describe("panelModeForDeskOpen", () => {
  it("folds fullscreen to the pill and leaves the pill alone", () => {
    expect(panelModeForDeskOpen("fullscreen")).toBe("pill");
    expect(panelModeForDeskOpen("pill")).toBe("pill");
  });
});

// A missing locale key is a visible MISSING_MESSAGE crash in the console —
// the desk.* set must exist, whole, in BOTH locales. The paper's furniture
// (letterhead category, shelf line, folio) is fixed English and holds NO
// keys here (v0.28); only the desk's chrome does.
describe("desk locale keys", () => {
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../messages/${name}`, import.meta.url)),
        "utf8",
      ),
    );

  it("en.json and zh.json carry the same desk.* keys, all non-empty", () => {
    const en = read("en.json").desk as Record<string, unknown>;
    const zh = read("zh.json").desk as Record<string, unknown>;
    expect(Object.keys(en).sort()).toEqual([
      "close",
      "loading",
      "nextPage",
      "notFoundBody",
      "notFoundHeading",
      "pagePosition",
      "prevPage",
      "recordAgent",
      "recordUser",
      "regionLabel",
      "zoomIn",
      "zoomOut",
      "zoomReset",
    ]);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });
});

// The letterhead (v0.28): `Previously` over three fixed-English lines —
// clock, bare category, shelf — each omitted when its data does not exist.
describe("mastheadLines", () => {
  it("a case paper: the stored date, the uppercased category, the shelf ref", () => {
    const lines = mastheadLines(
      deskPaperModel("research/rsi", doc("# x", "2026-10-05")),
    );
    expect(lines).toEqual({
      clock: "2026-10-05",
      category: "RESEARCH",
      shelf: "research / rsi",
    });
  });

  it("a record paper: the wall clock off the slice id + its timezone, RECORD, the day folder", () => {
    const lines = mastheadLines(
      deskPaperModel("records/2026-10-04-0131", {
        ...doc("**You**\n\nhi", "2026-10-04"),
        turnCount: 4,
        timezone: "Asia/Shanghai",
      }),
    );
    expect(lines).toEqual({
      clock: "2026-10-04 01:31 · Asia/Shanghai",
      category: "RECORD",
      shelf: "records / 2026-10-04",
    });
  });

  it("a dossier paper: honestly three lines — no shelf, the fixed name uppercased", () => {
    const lines = mastheadLines(
      deskPaperModel("dossier/previously", doc("# Previously on", "")),
    );
    expect(lines).toEqual({
      clock: null,
      category: "PREVIOUSLY ON",
      shelf: null,
    });
    expect(
      mastheadLines(deskPaperModel("dossier/direction", doc("# x"))).category,
    ).toBe("DIRECTION");
  });

  it("a dead link omits the clock but keeps the derivable lines", () => {
    const lines = mastheadLines(
      deskPaperModel("research/不存在的调研", null),
    );
    expect(lines).toEqual({
      clock: null,
      category: "RESEARCH",
      shelf: "research / 不存在的调研",
    });
  });

  it("a legacy ref has neither category nor shelf", () => {
    const lines = mastheadLines(
      deskPaperModel("用户手机", doc("旧文档", "2026-09-01")),
    );
    expect(lines).toEqual({
      clock: "2026-09-01",
      category: null,
      shelf: null,
    });
  });
});

describe("wrapPage (v0.29 — the stack is a cycle)", () => {
  it("steps forward past the last page back to the first", () => {
    expect(wrapPage(4, 3)).toBe(1);
    expect(wrapPage(3, 3)).toBe(3);
    expect(wrapPage(2, 3)).toBe(2);
  });

  it("steps back past the first page to the last", () => {
    expect(wrapPage(0, 3)).toBe(3);
    expect(wrapPage(-1, 3)).toBe(2);
    expect(wrapPage(1, 3)).toBe(1);
  });

  it("degenerates to page 1 on a one-page document or garbage input", () => {
    expect(wrapPage(5, 1)).toBe(1);
    expect(wrapPage(2, 0)).toBe(1);
    expect(wrapPage(Number.NaN, 4)).toBe(1);
    expect(wrapPage(3, Number.NaN)).toBe(1);
  });
});

describe("clampPage (v0.24)", () => {
  it("keeps the page inside [1, total]", () => {
    expect(clampPage(5, 3)).toBe(3);
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(2, 3)).toBe(2);
  });

  it("degenerates to page 1 of 1 on garbage input", () => {
    expect(clampPage(Number.NaN, 0)).toBe(1);
    expect(clampPage(3, Number.NaN)).toBe(1);
  });
});

describe("pageForShellSlot — the deck invariant (v0.24, cyclic in v0.29)", () => {
  it("top carries the current page, the second the next, the bottom the previous", () => {
    // [k][k+1][blank][blank][k-1] for k = 3 of 10, SHELL_COUNT = 5
    expect(pageForShellSlot(3, 10, 0, SHELL_COUNT)).toBe(3);
    expect(pageForShellSlot(3, 10, 1, SHELL_COUNT)).toBe(4);
    expect(pageForShellSlot(3, 10, 4, SHELL_COUNT)).toBe(2);
    expect(pageForShellSlot(3, 10, 2, SHELL_COUNT)).toBeNull();
    expect(pageForShellSlot(3, 10, 3, SHELL_COUNT)).toBeNull();
  });

  it("clamps the current page into range before deriving the neighbours", () => {
    // A resize shrank the document to 2 pages while the reader sat on 5.
    expect(pageForShellSlot(5, 2, 0, SHELL_COUNT)).toBe(2);
    expect(pageForShellSlot(5, 2, 1, SHELL_COUNT)).toBe(1);
    expect(pageForShellSlot(5, 2, 4, SHELL_COUNT)).toBe(1);
  });

  it("the ends WRAP: page 1's previous is the last page, the last page's next is the first", () => {
    expect(pageForShellSlot(1, 10, 4, SHELL_COUNT)).toBe(10);
    expect(pageForShellSlot(10, 10, 1, SHELL_COUNT)).toBe(1);
    expect(pageForShellSlot(10, 10, 4, SHELL_COUNT)).toBe(9);
    expect(pageForShellSlot(1, 10, 1, SHELL_COUNT)).toBe(2);
  });

  it("a two-page cycle shows the other page both ways; one page is never stacked", () => {
    expect(pageForShellSlot(1, 2, 1, SHELL_COUNT)).toBe(2);
    expect(pageForShellSlot(1, 2, 4, SHELL_COUNT)).toBe(2);
    expect(pageForShellSlot(1, 1, 1, SHELL_COUNT)).toBe(1);
  });
});

describe("shellOffsetForSlot — the peek cascade (v0.24)", () => {
  it("the top sheet sits at (0,0,0°); every slot beneath slips down-right cumulatively", () => {
    expect(shellOffsetForSlot(0)).toEqual({ x: 0, y: 0, r: 0 });
    expect(shellOffsetForSlot(4)).toEqual({ x: 20, y: 16, r: 1.4 });
    expect(shellOffsetForSlot(1)).toEqual({ x: 5, y: 4, r: 0.35 });
  });

  it("never goes negative above the top (a single sheet stacks at zero)", () => {
    expect(shellOffsetForSlot(-1)).toEqual({ x: 0, y: 0, r: 0 });
  });
});
