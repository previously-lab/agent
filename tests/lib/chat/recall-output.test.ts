import { describe, expect, it } from "vitest";
import {
  deriveWriteCaseStatus,
  parseRecallOutput,
} from "@/lib/chat/recall-output";

describe("parseRecallOutput — recallRecent", () => {
  it("parses a hit page with excerpts and refs", () => {
    const out =
      "The 2 most recent events entries:\n" +
      "- [2026-10-14] 换手机 — 下单了新手机 (ref: events/换手机)\n" +
      "- [2026-10-12] undated thing (ref: events/old)";
    const r = parseRecallOutput("recallRecent", out);
    expect(r).toEqual({
      kind: "entries",
      scope: "events",
      entries: [
        { date: "2026-10-14", title: "换手机", excerpt: "下单了新手机", ref: "events/换手机" },
        { date: "2026-10-12", title: "undated thing", excerpt: "", ref: "events/old" },
      ],
    });
  });

  it("parses an undated entry", () => {
    const out =
      "The 1 most recent memory entries:\n- [undated] 无日期条目 (ref: things/x)";
    const r = parseRecallOutput("recallRecent", out);
    expect(r?.kind).toBe("entries");
    if (r?.kind === "entries") {
      expect(r.entries[0]?.date).toBeUndefined();
    }
  });

  it("parses the offset page note", () => {
    const out =
      "The 3 most recent memory entries:\n" +
      "- [2026-10-14] a (ref: x/a)\n" +
      "- [2026-10-13] b (ref: x/b)\n" +
      "- [2026-10-12] c (ref: x/c)\n" +
      "Showing 3 from offset 3 — pass offset=6 for older ones.";
    const r = parseRecallOutput("recallRecent", out);
    expect(r?.kind).toBe("entries");
    if (r?.kind === "entries") {
      expect(r.note).toEqual({ kind: "offset", shown: 3, offset: 3, nextOffset: 6 });
    }
  });

  it("parses the scanned-cap note", () => {
    const out =
      '2 match(es) for "手机":\n' +
      "- [2026-10-14] a (ref: x/a)\n" +
      "- [2026-10-13] b (ref: x/b)\n" +
      "Showing the newest 2 of 50 scanned — narrow by date or add keywords for the older ones.";
    const r = parseRecallOutput("recallSearch", out);
    expect(r?.kind).toBe("entries");
    if (r?.kind === "entries") {
      expect(r.note).toEqual({ kind: "capped", shown: 2, scanned: 50 });
    }
  });

  it("parses a past-end page as pastEnd, not empty", () => {
    const out =
      "No more entries — offset 12 is past the end; only 10 exist in this scope, newest first.";
    const r = parseRecallOutput("recallRecent", out);
    expect(r).toEqual({ kind: "pastEnd", offset: 12, total: 10 });
  });

  it("parses an empty scope as empty", () => {
    const out =
      "There is nothing here yet — no events entries exist in this scope.";
    const r = parseRecallOutput("recallRecent", out);
    expect(r).toEqual({ kind: "empty", scope: "events" });
  });

  it("parses a read failure as readFailure", () => {
    const out =
      "This could not be read right now (slice heads could not be read). That is a read failure, not absence — it may still exist.";
    const r = parseRecallOutput("recallRecent", out);
    expect(r).toEqual({ kind: "readFailure", note: "slice heads could not be read" });
  });
});

describe("parseRecallOutput — recallFind", () => {
  it("parses a miss with near matches", () => {
    const out =
      'Nothing named "换手机" exists in events. Closest matches: events/换手机号, things/手机.';
    const r = parseRecallOutput("recallFind", out);
    expect(r).toEqual({
      kind: "notFound",
      name: "换手机",
      scope: "events",
      nearMisses: ["events/换手机号", "things/手机"],
    });
  });

  it("parses a miss with nothing similar", () => {
    const out = 'Nothing named "xyz" exists in memory — and nothing similar.';
    const r = parseRecallOutput("recallFind", out);
    expect(r).toEqual({ kind: "notFound", name: "xyz", scope: "memory", nearMisses: [] });
  });
});

describe("parseRecallOutput — recallSearch", () => {
  it("parses a hit page with the query", () => {
    const out =
      '2 match(es) for "手机 电池":\n' +
      "- [2026-10-14] 调研 — 电池续航不错 (ref: research/手机调研)";
    const r = parseRecallOutput("recallSearch", out);
    expect(r?.kind).toBe("entries");
    if (r?.kind === "entries") {
      expect(r.query).toBe("手机 电池");
      expect(r.entries[0]?.excerpt).toBe("电池续航不错");
    }
  });

  it("parses the zero-hit fallback as fallback, not empty", () => {
    const out =
      'Nothing matches "量子引力". Here are 2 most recent entries instead:\n' +
      "- [2026-10-14] a (ref: x/a)\n" +
      "- [2026-10-13] b (ref: x/b)";
    const r = parseRecallOutput("recallSearch", out);
    expect(r?.kind).toBe("fallback");
    if (r?.kind === "fallback") {
      expect(r.query).toBe("量子引力");
      expect(r.entries).toHaveLength(2);
    }
  });
});

describe("parseRecallOutput — recallRead", () => {
  it("parses a document body as content", () => {
    const out = "# 换手机\n\n- 2026-10-14 下单\n";
    const r = parseRecallOutput("recallRead", out);
    expect(r).toEqual({ kind: "content", text: out });
  });

  it("parses an unresolvable ref as notFound", () => {
    const out = 'Nothing named "events/不存在" exists in memory — and nothing similar.';
    const r = parseRecallOutput("recallRead", out);
    expect(r).toEqual({ kind: "notFound", name: "events/不存在", nearMisses: [] });
  });

  it("parses a read failure distinctly from notFound", () => {
    const out =
      "This could not be read right now (ENOTDIR). That is a read failure, not absence — it may still exist.";
    const r = parseRecallOutput("recallRead", out);
    expect(r?.kind).toBe("readFailure");
  });
});

describe("parseRecallOutput — degenerate inputs", () => {
  it("returns null for missing or non-string output", () => {
    expect(parseRecallOutput("recallRecent", undefined)).toBeNull();
    expect(parseRecallOutput("recallRecent", null)).toBeNull();
    expect(parseRecallOutput("recallRecent", 42)).toBeNull();
    expect(parseRecallOutput("recallRecent", "")).toBeNull();
  });

  it("returns unknown for unrecognized wording on list verbs", () => {
    const r = parseRecallOutput("recallRecent", "some new wording\n- whatever");
    expect(r?.kind).toBe("unknown");
  });

  it("keeps recallRead lenient: anything unreadable-as-state is content", () => {
    const out = "The 3 most recent memory entries:\n- [2026-10-14] a (ref: x/a)";
    const r = parseRecallOutput("recallRead", out);
    expect(r).toEqual({ kind: "content", text: out });
  });
});

describe("deriveWriteCaseStatus", () => {
  it("queued while the call is running with no output", () => {
    expect(deriveWriteCaseStatus(true, undefined)).toEqual({ kind: "queued" });
  });

  it("committed on ok:true with action and path", () => {
    const r = deriveWriteCaseStatus(false, {
      ok: true,
      action: "open",
      path: "memory/research/手机调研/index.md",
    });
    expect(r).toEqual({
      kind: "committed",
      action: "open",
      path: "memory/research/手机调研/index.md",
    });
  });

  it("committed addPiece", () => {
    const r = deriveWriteCaseStatus(false, {
      ok: true,
      action: "addPiece",
      path: "memory/research/手机调研/2026-10-14-报价篇.md",
    });
    expect(r.kind).toBe("committed");
  });

  it("refused on ok:false with the server's reason verbatim", () => {
    const reason = "case research/手机调研 already exists and no pieceTitle was given.";
    const r = deriveWriteCaseStatus(false, { ok: false, reason });
    expect(r).toEqual({ kind: "refused", reason });
  });

  it("parses a JSON-stringified output", () => {
    const r = deriveWriteCaseStatus(
      false,
      JSON.stringify({ ok: true, action: "open", path: "memory/events/x/index.md" }),
    );
    expect(r.kind).toBe("committed");
  });

  it("unknown for unrecognized shapes", () => {
    expect(deriveWriteCaseStatus(false, { weird: true }).kind).toBe("unknown");
    expect(deriveWriteCaseStatus(false, 7).kind).toBe("unknown");
  });
});
