/**
 * The document desk's pure decisions (v0.22 P1): the paper's view model
 * (title / case ref / category / the dead-link "not found" call), the
 * §12.2 recess intensity bounds, and the provider's open-desk panel fold.
 * The repo's vitest env is node (no component rendering), so everything the
 * desk decides lives here in React-free functions and is covered directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clampPage,
  deskPaperModel,
  pageCountLowerBound,
  pageForShellDepth,
  panelModeForDeskOpen,
  recessIntensityFor,
  SHELL_COUNT,
  shellOffsetForDepth,
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
});

describe("recessIntensityFor (§12.2)", () => {
  it("is 1 at mid-page, strongest toward the light, weakest at the foot", () => {
    expect(recessIntensityFor(0.5)).toBe(1);
    expect(recessIntensityFor(0)).toBe(1.3);
    expect(recessIntensityFor(1)).toBeCloseTo(0.7);
  });

  it("clamps out-of-range and non-finite input instead of escaping 0.7–1.3", () => {
    expect(recessIntensityFor(-5)).toBe(1.3);
    expect(recessIntensityFor(2)).toBeCloseTo(0.7);
    expect(recessIntensityFor(Number.NaN)).toBe(1);
    expect(recessIntensityFor(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("panelModeForDeskOpen", () => {
  it("folds fullscreen to the pill and leaves the pill alone", () => {
    expect(panelModeForDeskOpen("fullscreen")).toBe("pill");
    expect(panelModeForDeskOpen("pill")).toBe("pill");
  });
});

// A missing locale key is a visible MISSING_MESSAGE crash in the console —
// the desk.* set must exist, whole, in BOTH locales.
describe("desk locale keys", () => {
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../messages/${name}`, import.meta.url)),
        "utf8",
      ),
    );

  it("en.json and zh.json carry the same desk.* keys, all non-empty", () => {
    const en = read("en.json").desk as Record<string, string>;
    const zh = read("zh.json").desk as Record<string, string>;
    expect(Object.keys(en).sort()).toEqual([
      "loading",
      "nextPage",
      "notFoundBody",
      "notFoundHeading",
      "page",
      "pagePosition",
      "prevPage",
      "regionLabel",
    ]);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("pageCountLowerBound (v0.24)", () => {
  it("is the natural height over the page height, rounded up", () => {
    expect(pageCountLowerBound(1000, 500)).toBe(2);
    expect(pageCountLowerBound(1001, 500)).toBe(3);
    expect(pageCountLowerBound(500, 500)).toBe(1);
  });

  it("never returns below 1, and guards the unmeasured states", () => {
    expect(pageCountLowerBound(0, 500)).toBe(1);
    expect(pageCountLowerBound(1000, 0)).toBe(1);
    expect(pageCountLowerBound(Number.NaN, 500)).toBe(1);
    expect(pageCountLowerBound(1000, Number.NaN)).toBe(1);
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

describe("pageForShellDepth — the deck invariant (v0.24)", () => {
  it("top carries the current page, under-top the next, the bottom the previous", () => {
    // [k-1][blank][blank][k+1][k] for k = 3 of 10, SHELL_COUNT = 5
    expect(pageForShellDepth(3, 10, 4, SHELL_COUNT)).toBe(3);
    expect(pageForShellDepth(3, 10, 3, SHELL_COUNT)).toBe(4);
    expect(pageForShellDepth(3, 10, 0, SHELL_COUNT)).toBe(2);
    expect(pageForShellDepth(3, 10, 1, SHELL_COUNT)).toBeNull();
    expect(pageForShellDepth(3, 10, 2, SHELL_COUNT)).toBeNull();
  });

  it("clamps the current page into range before deriving the neighbours", () => {
    // A resize shrank the document to 2 pages while the reader sat on 5.
    expect(pageForShellDepth(5, 2, 4, SHELL_COUNT)).toBe(2);
    expect(pageForShellDepth(5, 2, 3, SHELL_COUNT)).toBeNull();
    expect(pageForShellDepth(5, 2, 0, SHELL_COUNT)).toBe(1);
  });

  it("page 1 has no previous; the last page has no next", () => {
    expect(pageForShellDepth(1, 10, 0, SHELL_COUNT)).toBeNull();
    expect(pageForShellDepth(10, 10, 3, SHELL_COUNT)).toBeNull();
    expect(pageForShellDepth(1, 1, 3, SHELL_COUNT)).toBeNull();
    expect(pageForShellDepth(1, 1, 0, SHELL_COUNT)).toBeNull();
  });
});

describe("shellOffsetForDepth — the peek cascade (v0.24)", () => {
  it("the top sheet sits at (0,0,0°); every sheet beneath slips down-right cumulatively", () => {
    expect(shellOffsetForDepth(SHELL_COUNT - 1)).toEqual({ x: 0, y: 0, r: 0 });
    expect(shellOffsetForDepth(0)).toEqual({ x: 20, y: 16, r: 1.4 });
    expect(shellOffsetForDepth(3)).toEqual({ x: 5, y: 4, r: 0.35 });
  });

  it("never goes negative above the top (a single sheet stacks at zero)", () => {
    expect(shellOffsetForDepth(SHELL_COUNT)).toEqual({ x: 0, y: 0, r: 0 });
  });
});
