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
  deskPaperModel,
  panelModeForDeskOpen,
  recessIntensityFor,
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
      "notFoundBody",
      "notFoundHeading",
      "page",
      "regionLabel",
    ]);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const value of [...Object.values(en), ...Object.values(zh)]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
