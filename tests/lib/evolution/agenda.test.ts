/**
 * Tests for the agenda pure module (src/lib/evolution/agenda.ts, v0.34 §6) —
 * the reflection unit's work pad at memory/self/agenda.md. The contract that
 * matters:
 *   - the `- [due: YYYY-MM-DD]` prefix is the ONLY mechanical contract; the
 *     provenance (据片 <sliceId>) rides inside the prose text;
 *   - parseAgenda degrades tolerantly: prose, headers, blank lines and
 *     malformed lines are skipped, null/garbage input yields [], and it
 *     never throws;
 *   - serialize/format round-trip with parse;
 *   - dueAgendaItems is the §6.2 due judgment: due <= the round's date
 *     (same-day counts as due), file order preserved.
 */
import { describe, it, expect } from "vitest";

import {
  AGENDA_PATH,
  parseAgenda,
  formatAgendaItem,
  serializeAgenda,
  dueAgendaItems,
  type AgendaItem,
} from "@/lib/evolution/agenda";

const DOC = [
  "# 议程",
  "",
  "- [due: 2026-10-18] 复查 hypotheses/厄尔尼诺：看新片是否证伪（据片 2026-10-14-1858）",
  "- [due: 2026-10-21] 复核 search SOP 里读回纪律是否还成立（据片 2026-10-16-0922）",
  "",
].join("\n");

describe("parseAgenda — the tolerant reader", () => {
  it("parses due-dated lines in file order; prose around them is ignored", () => {
    expect(parseAgenda(DOC)).toEqual([
      {
        due: "2026-10-18",
        text: "复查 hypotheses/厄尔尼诺：看新片是否证伪（据片 2026-10-14-1858）",
      },
      {
        due: "2026-10-21",
        text: "复核 search SOP 里读回纪律是否还成立（据片 2026-10-16-0922）",
      },
    ]);
  });

  it("keeps the provenance INSIDE the text — it is prose, not a parsed field", () => {
    const [item] = parseAgenda(DOC);
    expect(item.text).toContain("（据片 2026-10-14-1858）");
  });

  it("skips malformed lines and never throws", () => {
    const garbage = [
      "not a list line at all",
      "- [due: 18-10-2026] date in the wrong shape",
      "- [due: 2026-1-8] unpadded date",
      "- [due:] no date at all",
      "- [due: 2026-10-18]", // prefix but no note
      "- [du: 2026-10-18] typo in the marker",
      "[due: 2026-10-18] missing the dash",
      "- [due: 2026-10-19] 唯一好行（据片 2026-10-14-1858）",
      "undefined is fine too:",
    ].join("\n");
    expect(parseAgenda(garbage)).toEqual([
      { due: "2026-10-19", text: "唯一好行（据片 2026-10-14-1858）" },
    ]);
  });

  it("null / undefined / empty / blank input all yield an empty agenda", () => {
    expect(parseAgenda(null)).toEqual([]);
    expect(parseAgenda(undefined)).toEqual([]);
    expect(parseAgenda("")).toEqual([]);
    expect(parseAgenda("   \n\n\t\n")).toEqual([]);
  });

  it("survives CRLF files and indented list lines", () => {
    expect(parseAgenda("- [due: 2026-10-18] 甲\r\n  - [due: 2026-10-19] 乙\r\n")).toEqual([
      { due: "2026-10-18", text: "甲" },
      { due: "2026-10-19", text: "乙" },
    ]);
  });
});

describe("format / serialize — the round trip", () => {
  it("formatAgendaItem renders the canonical line", () => {
    expect(
      formatAgendaItem({ due: "2026-10-18", text: "复查（据片 2026-10-14-1858）" }),
    ).toBe("- [due: 2026-10-18] 复查（据片 2026-10-14-1858）");
  });

  it("serialize ∘ parse is stable on a well-formed document", () => {
    const items = parseAgenda(DOC);
    const serialized = serializeAgenda(items);
    expect(parseAgenda(serialized)).toEqual(items);
    expect(serialized).toBe(
      "- [due: 2026-10-18] 复查 hypotheses/厄尔尼诺：看新片是否证伪（据片 2026-10-14-1858）\n" +
        "- [due: 2026-10-21] 复核 search SOP 里读回纪律是否还成立（据片 2026-10-16-0922）\n",
    );
  });

  it("an empty agenda serializes to an empty document, which parses back empty", () => {
    expect(serializeAgenda([])).toBe("");
    expect(parseAgenda(serializeAgenda([]))).toEqual([]);
  });
});

describe("dueAgendaItems — the §6.2 due judgment (due <= date)", () => {
  const items: AgendaItem[] = [
    { due: "2026-10-16", text: "昨天到期" },
    { due: "2026-10-18", text: "今天到期" },
    { due: "2026-10-21", text: "还没到" },
  ];

  it("keeps overdue and same-day items, drops future ones, order preserved", () => {
    expect(dueAgendaItems(items, "2026-10-18")).toEqual([
      { due: "2026-10-16", text: "昨天到期" },
      { due: "2026-10-18", text: "今天到期" },
    ]);
  });

  it("nothing is due before the earliest date", () => {
    expect(dueAgendaItems(items, "2026-10-15")).toEqual([]);
  });
});

describe("the file's home", () => {
  it("lives at memory/self/agenda.md — self/ is the unit's own way of working", () => {
    expect(AGENDA_PATH).toBe("memory/self/agenda.md");
  });
});
