import { describe, expect, it } from "vitest";
import {
  defaultDeskView,
  deskPaperMarkdown,
  deskPaperModel,
  deskDocumentObservationKey,
  filterCurrentHistory,
} from "@/components/desk/desk-model";
import type { CaseDocContent } from "@/lib/episodic/actions";
import {
  parseCaseCurrent,
  reviseCaseCurrent,
  serializeCaseCurrent,
} from "@/lib/docs/case-doc";

function currentDoc(): CaseDocContent {
  return {
    ref: "research/phone",
    opened: "2026-10-01",
    closed: null,
    markdown: "ORIGINAL INDEX — preserved verbatim",
    warnings: [],
    current: {
      status: "ok",
      view: {
        asOf: "2026-10-26",
        body: "LATEST DATED UNDERSTANDING",
        sources: ["records/2026-10-25-1200", "research/phone"],
        history: "## 2026-10-20 — previous\nas-of: 2026-10-19\nevidence: records/old\nbasis-index: secret\nEarlier prose",
        indexChanged: true,
        missingAsOf: false,
        missingEvidence: false,
      },
    },
  };
}

describe("desk current reading model", () => {
  it("opens current first while preserving original and earlier views", () => {
    const model = deskPaperModel("research/phone", currentDoc());
    expect(model.markdown).toBe("ORIGINAL INDEX — preserved verbatim");
    expect(defaultDeskView(model)).toBe("current");
    expect(deskPaperMarkdown(model, "current")).toBe("LATEST DATED UNDERSTANDING");
    expect(deskPaperMarkdown(model, "original")).toBe("ORIGINAL INDEX — preserved verbatim");
    expect(deskPaperMarkdown(model, "history")).toContain("Earlier prose");
    expect(deskPaperMarkdown(model, "history")).not.toContain("basis-index");
    expect(model.current?.sources).toEqual(["records/2026-10-25-1200", "research/phone"]);
    expect(model.current?.indexChanged).toBe(true);
  });

  it("falls back to the original when current is absent or unavailable", () => {
    const original: CaseDocContent = {
      ref: "research/phone", opened: "2026-10-01", closed: null,
      markdown: "ORIGINAL", warnings: [],
    };
    expect(defaultDeskView(deskPaperModel("research/phone", original))).toBe("original");
    const unavailable = deskPaperModel("research/phone", {
      ...original,
      current: { status: "unavailable", warning: "read failed" },
    });
    expect(unavailable.current).toBeNull();
    expect(defaultDeskView(unavailable)).toBe("original");
    expect(deskPaperMarkdown(unavailable, "current")).toBe("ORIGINAL");
  });

  it("filters engineering metadata from earlier views, not their prose or dates", () => {
    const history = filterCurrentHistory(
      "---\n## Previous\nas-of: 2026-10-01\nevidence: records/a\nbasis-index: hash\nbasis-pieces: hashes\n---\nDated prose",
    );
    expect(history).toBe("## Previous\n**2026-10-01**\nDated prose");
  });

  it("keeps real revised history prose, dates, and exact source links", () => {
    const previous = reviseCaseCurrent(null, {
      asOf: "2026-10-20",
      evidence: ["records/2026-10-19-1200"],
      body: "Actual earlier prose",
    });
    const revised = reviseCaseCurrent(previous, {
      asOf: "2026-10-26",
      evidence: ["records/2026-10-25-1200"],
      body: "Actual current prose",
    });
    const stored = parseCaseCurrent(serializeCaseCurrent(revised));
    const current = deskPaperModel("research/phone", {
      ...currentDoc(),
      current: {
        status: "ok",
        view: {
          asOf: stored.asOf,
          body: stored.body,
          sources: stored.evidence,
          history: stored.history,
          indexChanged: null,
          missingAsOf: false,
          missingEvidence: false,
        },
      },
    }).current!;
    expect(deskPaperMarkdown(deskPaperModel("research/phone", {
      ...currentDoc(),
      current: { status: "ok", view: {
        asOf: stored.asOf, body: stored.body, sources: stored.evidence,
        history: stored.history, indexChanged: null,
        missingAsOf: false, missingEvidence: false,
      } },
    }), "history")).toContain("Actual earlier prose");
    expect(current.history).toContain("**2026-10-20**");
    expect(current.history).not.toMatch(/as-of:|evidence:|basis-/);
    expect(current.historySources).toEqual(["records/2026-10-19-1200"]);
  });

  it("observation identity includes every visible reading coordinate", () => {
    const base = { docRef: "research/phone", title: "phone", edition: "current" as const, page: 1, total: 3 };
    expect(deskDocumentObservationKey(base)).not.toBe(deskDocumentObservationKey({ ...base, page: 2 }));
    expect(deskDocumentObservationKey(base)).not.toBe(deskDocumentObservationKey({ ...base, edition: "original" }));
    expect(deskDocumentObservationKey(base)).not.toBe(deskDocumentObservationKey({ ...base, total: 4 }));
  });
});
