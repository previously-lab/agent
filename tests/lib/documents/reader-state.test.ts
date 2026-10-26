import { describe, expect, it } from "vitest";
import { collectRelatedDocuments } from "@/lib/documents/related-documents";
import {
  readDeskReadingLocation,
  writeDeskReadingLocation,
  type DeskReadingLocation,
} from "@/lib/documents/reading-location";
import { paperPageForPoint, resolveRecordTurnAnchor } from "@/lib/documents/record-location";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

const location: DeskReadingLocation = {
  edition: "history",
  page: 4,
  zoom: 1.4,
  fit: false,
  panX: 12,
  panY: -8,
  initialSignature: "[\"turn-1\",\"user\",null]",
};

describe("reader location state", () => {
  it("restores only matching source/persona/ref coordinates and stores no document text", () => {
    const store = storage();
    writeDeskReadingLocation(store, "deployment-a", "persona-a", "research/rest", location);
    expect(readDeskReadingLocation(store, "deployment-a", "persona-a", "research/rest")).toEqual(location);
    expect(readDeskReadingLocation(store, "deployment-a", "persona-b", "research/rest")).toBeNull();
    expect(readDeskReadingLocation(store, "deployment-b", "persona-a", "research/rest")).toBeNull();
    expect(readDeskReadingLocation(store, "deployment-a", "persona-a", "research/other")).toBeNull();
    const raw = [...store.values.values()].join("\n");
    expect(raw).not.toContain("markdown");
    expect(raw).not.toContain("quote");
    expect(raw).not.toContain("document body");
  });

  it("bounds stored locations and tolerates malformed storage", () => {
    const store = storage();
    for (let index = 0; index < 30; index += 1) {
      writeDeskReadingLocation(store, "scope", "persona", `research/doc-${index}`, {
        ...location,
        page: index + 1,
      });
    }
    const raw = [...store.values.values()][0];
    expect(JSON.parse(raw).entries).toHaveLength(24);
    expect(readDeskReadingLocation(store, "scope", "persona", "research/doc-29")?.page).toBe(30);
    expect(readDeskReadingLocation(store, "scope", "persona", "research/doc-0")).toBeNull();
    store.setItem("previously:reading-locations:v1", "not json");
    expect(readDeskReadingLocation(store, "scope", "persona", "research/doc-29")).toBeNull();
  });
});

describe("related documents", () => {
  it("uses only explicit semantic/plain/evidence/submitted refs with bounded honest targets", () => {
    const related = collectRelatedDocuments({
      currentRef: "research/current",
      markdown: [
        "[休息讨论](previously:research/rest?edition=original)",
        "原文 records/2026-10-12-1430",
        "`previously:research/code`",
        "![image](previously:research/image)",
        "[external](https://example.com)",
        "```md",
        "[code fence](previously:research/fence)",
        "```",
      ].join("\n\n"),
      evidence: ["records/2026-10-12-1430"],
      submitted: [{
        ref: "research/selected",
        title: "Selected document",
        turnId: "turn-1",
        role: "user",
        edition: "current",
      }],
    });
    expect(related.map((item) => item.ref)).toEqual([
      "research/rest",
      "records/2026-10-12-1430",
      "research/selected",
    ]);
    expect(related[0]).toEqual({
      ref: "research/rest",
      title: "休息讨论",
      location: { edition: "original" },
    });
    expect(related[1].ref).toBe("records/2026-10-12-1430");
    expect(related[2]).toEqual({
      ref: "research/selected",
      title: "Selected document",
      location: { turnId: "turn-1", role: "user", edition: "current" },
    });
    expect(related.some((item) => ["research/code", "research/image", "research/fence"].includes(item.ref))).toBe(false);
  });
});

describe("record anchors", () => {
  const turns = [
    { index: 0, turnId: "shared", role: "user" as const },
    { index: 1, turnId: "shared", role: "assistant" as const },
    { index: 2, turnId: "later", role: "assistant" as const },
  ];

  it("requires role when a real record reuses a turn id", () => {
    expect(resolveRecordTurnAnchor(turns, "shared")).toEqual({ status: "ambiguous" });
    expect(resolveRecordTurnAnchor(turns, "shared", "assistant")).toEqual({ status: "found", index: 1 });
    expect(resolveRecordTurnAnchor(turns, "later", "assistant")).toEqual({ status: "found", index: 2 });
    expect(resolveRecordTurnAnchor(turns, "missing", "user")).toEqual({ status: "missing" });
  });

  it("computes a later paper page from the translated flow geometry", () => {
    expect(paperPageForPoint({ pagesLeft: -800, targetLeft: 800, pageWidth: 800, zoom: 1 })).toBe(3);
    expect(paperPageForPoint({ pagesLeft: 0, targetLeft: 500, pageWidth: 800, zoom: 1 })).toBe(1);
    expect(paperPageForPoint({ pagesLeft: 0, targetLeft: 0, pageWidth: 0, zoom: 1 })).toBeNull();
  });
});
