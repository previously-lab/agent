/**
 * The memory-read facade (v0.36) — unit tests over a Map-backed fake backend.
 *
 * Coverage contract (batch-1 acceptance):
 * - every result kind at least once: entries / fallback / empty / not_found / unavailable
 * - every verb at least once: recallRecent / recallFind / recallSearch / recallRead
 * - every pinned excerpt rule once: slice→focus, case→first prose line, piece→first
 *   line, agenda→first due line, profile→first non-empty line
 * - scan discipline: records bodies are NOT scanned by default; explicit
 *   category/includeRecords scans them
 * - recent ordering by ACTIVITY (max(updated, latest piece date)), not birth
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recallRecent,
  recallFind,
  recallSearch,
  recallRead,
  renderRecallResult,
  renderRecallReadResult,
  buildTreeIndex,
  sliceHeadText,
  firstProseLine,
  type RecallBackend,
  type RecallResult,
} from "@/lib/memory/facade";

// ─── Fake backend ──────────────────────────────────────────────────────────

function makeBackend(files: Record<string, string>): RecallBackend {
  const map = new Map(Object.entries(files));
  return {
    listMemoryFiles: async () => [...map.keys()].sort(),
    readFile: async (path: string) => {
      const v = map.get(path);
      if (v === undefined) throw new Error(`File not found: "${path}"`);
      return v;
    },
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const CASE_INDEX = `---
opened: 2026-09-05
updated: 2026-09-05T13:22:10.000Z
---

倾向小屏旗舰，预算卡在 6000。证据见切片 2026-09-04-2130。
`;

const CASE_PIECE = `---
opened: 2026-09-08
updated: 2026-09-08T10:00:00.000Z
---

报价篇正文：三家供应商报价都高于预算。
`;

/** Born old, touched TODAY via a fresh piece — must outrank newer births. */
const STALE_BORN_ACTIVE = `---
opened: 2026-09-01
updated: 2026-09-01T09:00:00.000Z
---

老案子：上周大开的调研。
`;
const STALE_BORN_ACTIVE_PIECE = `---
opened: 2026-10-18
---

今天重写了一遍，结论变了。
`;

/** Born yesterday, untouched since — must sink below the old-but-active case. */
const FRESH_BORN_IDLE = `---
opened: 2026-10-17
updated: 2026-10-17T09:00:00.000Z
---

昨天才开的案子，此后没动过。
`;

const HYPOTHESIS_INDEX = `---
opened: 2026-09-12
updated: 2026-09-12T09:00:00.000Z
---

假设：续航焦虑主要来自充电基础设施而非电池容量。证伪条件：……
`;

const SELF_SOP = `---
opened: 2026-08-01
updated: 2026-08-01T09:00:00.000Z
---

搜索 SOP 正文：先小后大。
`;

const AGENDA = `# agenda

- [due: 2026-10-20] 还书
- 随便一行
`;

const PROFILE = `## 自述

我叫 Dream，做独立开发。
`;

const USER_INDEX = `---
opened: 2026-07-01
updated: 2026-07-01T09:00:00.000Z
---

用户模型卡片正文。
`;

function sliceCore(focus: string | null, userLine: string, extraBodyLines = 0): string {
  const fm = focus
    ? `---\nfocus: ${focus}\nsummary: 补充摘要\n---\n`
    : `---\nstart: 2026-10-14T18:36:00.000Z\n---\n`;
  let body = `## Turn 1 — 2026-10-14T18:36:00.000Z (user)\n\n${userLine}\n\n## Turn 2 — 2026-10-14T18:37:00.000Z (assistant)\n\n收到。\n`;
  if (extraBodyLines > 0) {
    body += "\n" + Array.from({ length: extraBodyLines }, (_, i) => `填充行 ${i + 1}`).join("\n") + "\n";
  }
  return `${fm}\n${body}`;
}

const FILES: Record<string, string> = {
  "memory/research/手机调研/index.md": CASE_INDEX,
  "memory/research/手机调研/2026-09-08-报价篇.md": CASE_PIECE,
  // hypotheses fold into research with kind "hypothesis" (ruling #2)
  "memory/hypotheses/续航假设/index.md": HYPOTHESIS_INDEX,
  // activity-order pair (ruling v0.36 §7-3)
  "memory/things/老案子/index.md": STALE_BORN_ACTIVE,
  "memory/things/老案子/2026-10-18-重写篇.md": STALE_BORN_ACTIVE_PIECE,
  "memory/events/新案子/index.md": FRESH_BORN_IDLE,
  // self: a SOP case + the bare agenda file (ruling #3)
  "memory/self/search/index.md": SELF_SOP,
  "memory/self/agenda.md": AGENDA,
  // people/user: the live card case + the bare profile file
  "memory/people/user/index.md": USER_INDEX,
  "memory/people/user/profile.md": PROFILE,
  // records
  "memory/records/2026/10/14/1836/core.md": sliceCore("讨论手机选购", "想换 iPhone Air"),
  "memory/records/2026/10/14/1836/agent.md": "agent cognition\n",
  "memory/records/2026/10/14/1836/previously.md": `## User profile

snapshot line.

## Self-model

snapshot body.
`,
  "memory/records/2026/10/09/2143/core.md": sliceCore(null, "想换 iPhone Air，主要顾虑是续航"),
  // a deep-body-only keyword: present in slice text past the 30-line head,
  // absent from every structured document — the scan-discipline probe.
  "memory/records/2026/10/08/1000/core.md": sliceCore(
    null,
    "随便聊聊",
    60,
  ).replace("填充行 60", "深埋关键词-企鹅"),
};

let backend: RecallBackend;

beforeEach(() => {
  backend = makeBackend(FILES);
});

function entriesOf(r: RecallResult) {
  if (r.kind !== "entries") throw new Error(`expected entries, got ${r.kind}`);
  return r.entries;
}

// ─── Verb ① recallRecent ───────────────────────────────────────────────────

describe("recallRecent", () => {
  it("returns recent entries for a case category (kind: entries)", async () => {
    const r = await recallRecent(backend, { category: "research" });
    const entries = entriesOf(r);
    expect(entries.length).toBeGreaterThan(0);
    // Activity order: 续航假设 (updated 09-12) outranks 手机调研 (activity 09-08).
    expect(entries[0]!.ref).toBe("research/续航假设");
    expect(entries[0]!.kind).toBe("hypothesis");
    expect(entries.map((e) => e.ref)).toContain("research/手机调研");
  });

  it("orders cases by ACTIVITY — max(updated, latest piece date), not birth (v0.36 §7-3)", async () => {
    const r = await recallRecent(backend, { category: "things", n: 10 });
    const entries = entriesOf(r);
    expect(entries.map((e) => e.ref)).toEqual(["things/老案子"]);
    // The activity date rides on the fresh piece, not the September birth.
    expect(entries[0]!.date).toBe("2026-09-01");
  });

  it("research folds hypotheses in with kind hypothesis (ruling #2)", async () => {
    const r = await recallRecent(backend, { category: "research" });
    const hy = entriesOf(r).find((e) => e.ref === "research/续航假设");
    expect(hy?.kind).toBe("hypothesis");
    expect(hy?.category).toBe("research");
  });

  it("cross-category view (no category) merges cases, bare files, and slices", async () => {
    const r = await recallRecent(backend, { n: 30 });
    const entries = entriesOf(r);
    const refs = entries.map((e) => e.ref);
    expect(refs).toContain("records/2026-10-14-1836");
    expect(refs).toContain("self/agenda");
    expect(refs).toContain("people/user/profile");
    // Activity order: the old-but-touched case (piece 2026-10-18) leads —
    // ahead of every slice and of the newer-born idle case.
    expect(entries[0]!.ref).toBe("things/老案子");
  });

  it("records category lists slice heads, newest first", async () => {
    const r = await recallRecent(backend, { category: "records" });
    const entries = entriesOf(r);
    expect(entries[0]!.ref).toBe("records/2026-10-14-1836");
    expect(entries[0]!.kind).toBe("slice");
    expect(entries.every((e) => e.category === "records")).toBe(true);
  });

  it("kind: empty when the category has nothing", async () => {
    const r = await recallRecent(backend, { category: "orgs" });
    expect(r).toEqual({ kind: "empty" });
  });

  it("date filters bound the scope (inclusive day compare)", async () => {
    const r = await recallRecent(backend, { category: "records", after: "2026-10-10" });
    const entries = entriesOf(r);
    expect(entries.map((e) => e.ref)).toEqual(["records/2026-10-14-1836"]);
  });

  it("respects n and reports truncation", async () => {
    const r = await recallRecent(backend, { category: "records", n: 1 });
    if (r.kind !== "entries") throw new Error("expected entries");
    expect(r.entries).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("offset pages deeper — no overlap, no skips, fixed page wording", async () => {
    // 3 slices in records, newest first: 10-14, 10-09, 10-08.
    const p1 = await recallRecent(backend, { category: "records", n: 1, offset: 0 });
    const p2 = await recallRecent(backend, { category: "records", n: 1, offset: 1 });
    const p3 = await recallRecent(backend, { category: "records", n: 1, offset: 2 });
    const refs = (r: RecallResult) =>
      r.kind === "entries" ? r.entries.map((e) => e.ref) : [];
    const r1 = refs(p1);
    const r2 = refs(p2);
    const r3 = refs(p3);
    expect(r1).toEqual(["records/2026-10-14-1836"]);
    expect(r2).toEqual(["records/2026-10-09-2143"]);
    expect(r3).toEqual(["records/2026-10-08-1000"]);
    // no overlap, no skips
    expect(new Set([...r1, ...r2, ...r3]).size).toBe(3);
    if (p1.kind !== "entries" || p3.kind !== "entries") {
      throw new Error("expected entries");
    }
    // a full page with older entries behind it carries the FIXED wording
    expect(p1.truncated).toBe(true);
    const text = renderRecallResult(p1, { category: "records" });
    expect(text).toContain(
      "Showing 1 from offset 0 — pass offset=1 for older ones.",
    );
    // the last page is complete: no continuation note
    expect(p3.truncated).toBe(false);
    expect(renderRecallResult(p3, { category: "records" })).not.toContain(
      "for older ones.",
    );
  });

  it("an offset past the end returns an empty page with the FIXED wording — not absence", async () => {
    const r = await recallRecent(backend, { category: "records", n: 1, offset: 3 });
    if (r.kind !== "entries") throw new Error("expected entries");
    expect(r.entries).toHaveLength(0);
    expect(r.pastEnd).toBe(true);
    expect(renderRecallResult(r, { category: "records" })).toBe(
      "No more entries — offset 3 is past the end; only 3 exist in this scope, newest first.",
    );
  });

  it("a negative / fractional offset floors to 0 — the first page", async () => {
    const r = await recallRecent(backend, { category: "records", n: 1, offset: -5 });
    const r2 = await recallRecent(backend, { category: "records", n: 1, offset: 0.9 });
    if (r.kind !== "entries" || r2.kind !== "entries") throw new Error("expected entries");
    expect(r.entries.map((e) => e.ref)).toEqual(["records/2026-10-14-1836"]);
    expect(r2.entries.map((e) => e.ref)).toEqual(["records/2026-10-14-1836"]);
    expect(r.offset).toBe(0); // clamped, and marked so the model learns to page
    expect(r2.offset).toBe(0);
  });
});

// ─── Verb ② recallFind ────────────────────────────────────────────────────

describe("recallFind", () => {
  it("finds a case by exact name (single entry)", async () => {
    const r = await recallFind(backend, { category: "research", name: "手机调研" });
    const entries = entriesOf(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ref).toBe("research/手机调研");
  });

  it("finds a slice by id (records) and by day (timeline)", async () => {
    const byId = await recallFind(backend, { category: "records", name: "2026-10-14-1836" });
    expect(entriesOf(byId)[0]!.ref).toBe("records/2026-10-14-1836");
    const byDay = await recallFind(backend, { category: "timeline", name: "2026-10-14" });
    expect(entriesOf(byDay)[0]!.category).toBe("timeline");
  });

  it("finds the bare-file specials by reserved ref (ruling #3)", async () => {
    const agenda = await recallFind(backend, { category: "self", name: "agenda" });
    expect(entriesOf(agenda)[0]!.ref).toBe("self/agenda");
    const sop = await recallFind(backend, { category: "self", name: "search" });
    expect(entriesOf(sop)[0]!.kind).toBe("sop");
  });

  it("kind: not_found with near misses for an unknown name", async () => {
    const r = await recallFind(backend, { category: "research", name: "手机" });
    if (r.kind !== "not_found") throw new Error(`expected not_found, got ${r.kind}`);
    expect(r.nearMisses.map((e) => e.ref)).toContain("research/手机调研");
  });

  it("kind: not_found with an empty near-miss list when nothing is similar", async () => {
    const r = await recallFind(backend, { category: "things", name: "完全不相干" });
    expect(r).toEqual({ kind: "not_found", nearMisses: [] });
  });
});

// ─── Verb ③ recallSearch ──────────────────────────────────────────────────

describe("recallSearch", () => {
  it("finds structured documents by keyword (kind: entries)", async () => {
    const r = await recallSearch(backend, { query: "小屏旗舰" });
    const entries = entriesOf(r);
    expect(entries[0]!.ref).toBe("research/手机调研");
    expect(entries[0]!.excerpt).toContain("小屏旗舰");
  });

  it("hit excerpts override the per-class defaults (search-snippet rule)", async () => {
    const r = await recallSearch(backend, { query: "报价" });
    const hit = entriesOf(r).find((e) => e.ref === "research/手机调研/2026-09-08-报价篇");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).toContain("报价");
  });

  it("scan discipline: records bodies are NOT scanned by default", async () => {
    // 深埋关键词-企鹅 lives only inside a slice body, past the 30-line head:
    // zero hits → fallback, even though the word IS in the record.
    const r = await recallSearch(backend, { query: "深埋关键词" });
    if (r.kind !== "fallback") throw new Error(`expected fallback, got ${r.kind}`);
    expect(r.reason).toBe("no_match");
  });

  it("scan discipline: category records scans slice bodies", async () => {
    const r = await recallSearch(backend, { query: "深埋关键词", category: "records" });
    const entries = entriesOf(r);
    expect(entries.some((e) => e.ref === "records/2026-10-08-1000")).toBe(true);
  });

  it("scan discipline: includeRecords adds slice bodies to the default scope", async () => {
    const r = await recallSearch(backend, { query: "深埋关键词", includeRecords: true });
    const entries = entriesOf(r);
    expect(entries.some((e) => e.ref === "records/2026-10-08-1000")).toBe(true);
  });

  it("kind: empty when the scope has nothing at all", async () => {
    const r = await recallSearch(backend, { query: "x", category: "orgs" });
    expect(r).toEqual({ kind: "empty" });
  });

  it("reports the scan cap as truncated and scans newest-first", async () => {
    // 51+ candidates: 8 case docs + 2 bare files + 3 slice heads = 13… add a
    // spread of extra cases so the 50-file cap actually fires.
    const many: Record<string, string> = { ...FILES };
    for (let i = 0; i < 60; i += 1) {
      many[`memory/events/填充${String(i).padStart(2, "0")}/index.md`] = `---\nopened: 2026-10-01\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n填充案 ${i}。\n`;
    }
    const r = await recallSearch(makeBackend(many), { query: "填充", limit: 5 });
    if (r.kind !== "entries") throw new Error(`expected entries, got ${r.kind}`);
    expect(r.scanned).toBe(50);
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBeLessThanOrEqual(5);
    const text = renderRecallResult(r, { query: "填充", limit: 5 });
    expect(text).toContain("Showing the newest 5 of 50 scanned");
  });

  it("date bounds filter candidates by activity date", async () => {
    const r = await recallSearch(backend, { query: "手机", since: "2026-10-01" });
    const entries = entriesOf(r);
    expect(entries.length).toBeGreaterThan(0);
    // The research case (activity 2026-09-08) is out of range; in-range slice
    // heads match instead.
    expect(entries.every((e) => e.date >= "2026-10-01")).toBe(true);
    expect(entries.some((e) => e.kind === "slice")).toBe(true);
  });

  it("offset pages the hits — no overlap, no skips, fixed page wording", async () => {
    // "想换 iPhone Air" hits two slice heads (10-14 and 10-09), newest first.
    const p1 = await recallSearch(backend, { query: "iPhone", limit: 1, offset: 0 });
    const p2 = await recallSearch(backend, { query: "iPhone", limit: 1, offset: 1 });
    if (p1.kind !== "entries" || p2.kind !== "entries") {
      throw new Error("expected entries");
    }
    expect(p1.entries.map((e) => e.ref)).toEqual(["records/2026-10-14-1836"]);
    expect(p2.entries.map((e) => e.ref)).toEqual(["records/2026-10-09-2143"]);
    expect(p2.offset).toBe(1);
    expect(p1.total).toBe(2);
    const text = renderRecallResult(p1, { query: "iPhone" });
    expect(text).toContain("Showing 1 from offset 0 — pass offset=1 for older ones.");
    // the second page is complete — no continuation note
    expect(p2.truncated).toBe(false);
    expect(renderRecallResult(p2, { query: "iPhone" })).not.toContain(
      "for older ones.",
    );
  });

  it("an offset past the hits returns an empty page with the FIXED wording", async () => {
    const r = await recallSearch(backend, { query: "iPhone", limit: 1, offset: 2 });
    if (r.kind !== "entries") throw new Error("expected entries");
    expect(r.entries).toHaveLength(0);
    expect(r.pastEnd).toBe(true);
    expect(r.total).toBe(2);
    expect(renderRecallResult(r, { query: "iPhone" })).toBe(
      "No more entries — offset 2 is past the end; only 2 exist in this scope, newest first.",
    );
  });
});

// ─── Verb ④ recallRead ────────────────────────────────────────────────────

describe("recallRead", () => {
  it("reads a case index by ref", async () => {
    const r = await recallRead(backend, { ref: "research/手机调研" });
    if (r.kind !== "content") throw new Error(`expected content, got ${r.kind}`);
    expect(r.content).toBe(CASE_INDEX);
    expect(r.path).toBe("memory/research/手机调研/index.md");
  });

  it("reads a dated piece by ref", async () => {
    const r = await recallRead(backend, { ref: "research/手机调研/2026-09-08-报价篇" });
    if (r.kind !== "content") throw new Error(`expected content, got ${r.kind}`);
    expect(r.content).toContain("报价篇正文");
  });

  it("research refs also resolve hypotheses on the tree (ruling #2)", async () => {
    const r = await recallRead(backend, { ref: "research/续航假设" });
    if (r.kind !== "content") throw new Error(`expected content, got ${r.kind}`);
    expect(r.content).toContain("假设：续航焦虑");
  });

  it("reads slice parts: core (default), agent, previously", async () => {
    const core = await recallRead(backend, { ref: "records/2026-10-14-1836" });
    if (core.kind !== "content") throw new Error("expected content");
    expect(core.content).toContain("讨论手机选购");
    const agent = await recallRead(backend, { ref: "records/2026-10-14-1836", part: "agent" });
    if (agent.kind !== "content") throw new Error("expected content");
    expect(agent.content).toContain("agent cognition");
    const prev = await recallRead(backend, {
      ref: "records/2026-10-14-1836",
      part: "previously",
      timezone: "Asia/Shanghai",
    });
    if (prev.kind !== "content") throw new Error("expected content");
    expect(prev.content).toContain("snapshot body.");
    // The user-local banner is prepended above the snapshot (never raw-equal).
    expect(prev.content.startsWith("## User profile")).toBe(false);
  });

  it("reads the bare-file specials (ruling #3)", async () => {
    const agenda = await recallRead(backend, { ref: "self/agenda" });
    if (agenda.kind !== "content") throw new Error("expected content");
    expect(agenda.content).toBe(AGENDA);
    const profile = await recallRead(backend, { ref: "people/user/profile" });
    if (profile.kind !== "content") throw new Error("expected content");
    expect(profile.content).toBe(PROFILE);
  });

  it("slice range: search returns matched turns with ±1 turn context", async () => {
    const r = await recallRead(backend, {
      ref: "records/2026-10-14-1836",
      range: { type: "search", keywords: ["iPhone"] },
    });
    if (r.kind !== "content") throw new Error("expected content");
    expect(r.content).toContain("Matched 1 segment");
    expect(r.content).toContain("iPhone Air");
    // The neighboring turn rides along as context (the segment protocol).
    expect(r.content).toContain("收到。");
  });

  it("slice range: last N turns", async () => {
    const r = await recallRead(backend, {
      ref: "records/2026-10-14-1836",
      range: { type: "last", count: 1 },
    });
    if (r.kind !== "content") throw new Error("expected content");
    expect(r.content).toContain("收到。");
    expect(r.content).not.toContain("想换 iPhone Air");
  });

  it("kind: not_found for an unresolvable ref — never a throw", async () => {
    const r = await recallRead(backend, { ref: "research/不存在" });
    expect(r).toEqual({ kind: "not_found" });
    const badSlice = await recallRead(backend, { ref: "records/2099-01-01-0000" });
    expect(badSlice.kind).toBe("not_found");
  });

  it("kind: unavailable distinguishes a read failure from absence", async () => {
    const flaky: RecallBackend = {
      listMemoryFiles: backend.listMemoryFiles,
      readFile: async () => {
        throw new Error("backend exploded");
      },
    };
    const r = await recallRead(flaky, { ref: "self/agenda" });
    if (r.kind !== "unavailable") throw new Error(`expected unavailable, got ${r.kind}`);
    expect(r.note).toContain("backend exploded");
  });
});

// ─── Excerpt rules (v0.36 §2.1 — pinned per class) ───────────────────────

describe("excerpt rules", () => {
  it("slice → the focus field", async () => {
    const r = await recallRecent(backend, { category: "records" });
    const slice = entriesOf(r).find((e) => e.ref === "records/2026-10-14-1836");
    expect(slice?.excerpt).toBe("讨论手机选购");
  });

  it("slice without focus → first user turn's first line", async () => {
    const r = await recallRecent(backend, { category: "records" });
    const slice = entriesOf(r).find((e) => e.ref === "records/2026-10-09-2143");
    expect(slice?.excerpt).toContain("想换 iPhone Air");
  });

  it("case index → the first prose line after the frontmatter (no frontmatter residue)", async () => {
    const r = await recallFind(backend, { category: "research", name: "手机调研" });
    expect(entriesOf(r)[0]!.excerpt).toBe("倾向小屏旗舰，预算卡在 6000。证据见切片 2026-09-04-2130。");
  });

  it("piece → the piece body's first line", async () => {
    const read = await recallRead(backend, { ref: "research/手机调研/2026-09-08-报价篇" });
    if (read.kind !== "content") throw new Error("expected content");
    expect(firstProseLine(read.content.replace(/^---\n[\s\S]*?\n---\n/, ""))).toBe(
      "报价篇正文：三家供应商报价都高于预算。",
    );
  });

  it("agenda → the first `- [due: …]` line", async () => {
    const r = await recallRecent(backend, { category: "self" });
    const agenda = entriesOf(r).find((e) => e.ref === "self/agenda");
    expect(agenda?.excerpt).toBe("- [due: 2026-10-20] 还书");
  });

  it("profile → the first non-empty, non-heading line", async () => {
    const r = await recallRecent(backend, { category: "people" });
    const profile = entriesOf(r).find((e) => e.ref === "people/user/profile");
    expect(profile?.excerpt).toBe("我叫 Dream，做独立开发。");
  });
});

// ─── Fixed rendering (v0.36 §3.2 — pinned text) ──────────────────────────

describe("fixed rendering", () => {
  it("entries (search) opens with the match-count template", async () => {
    const r = await recallSearch(backend, { query: "小屏旗舰" });
    const text = renderRecallResult(r, { query: "小屏旗舰" });
    expect(text).toMatch(/^1 match\(es\) for "小屏旗舰":/);
    expect(text).toContain("(ref: research/手机调研)");
  });

  it("entries (recent/find) opens with the most-recent template", async () => {
    const r = await recallRecent(backend, { category: "research" });
    const text = renderRecallResult(r, { category: "research" });
    expect(text).toMatch(/^The \d+ most recent research entries:/);
  });

  it("fallback renders the no-match sentence", async () => {
    const r = await recallSearch(backend, { query: "不存在的东西" });
    const text = renderRecallResult(r, { query: "不存在的东西" });
    expect(text).toMatch(/^Nothing matches "不存在的东西"\. Here are the \d+ most recent entries instead:/);
  });

  it("empty renders the nothing-here sentence", async () => {
    const text = renderRecallResult({ kind: "empty" }, { category: "orgs" });
    expect(text).toBe(
      "There is nothing here yet — no orgs entries exist in this scope.",
    );
  });

  it("not_found renders the closest-matches sentence", async () => {
    const r = await recallFind(backend, { category: "research", name: "手机" });
    const text = renderRecallResult(r, { category: "research", name: "手机" });
    expect(text).toMatch(
      /^Nothing named "手机" exists in research\. Closest matches: research\/手机调研\./,
    );
    const none = renderRecallResult(
      { kind: "not_found", nearMisses: [] },
      { category: "things", name: "x" },
    );
    expect(none).toBe('Nothing named "x" exists in things — and nothing similar.');
  });

  it("unavailable renders the read-failure sentence — never collapses into absence", async () => {
    const text = renderRecallResult(
      { kind: "unavailable", note: "rate limited" },
      {},
    );
    expect(text).toBe(
      "This could not be read right now (rate limited). That is a read failure, not absence — it may still exist.",
    );
  });

  it("recallRead not_found/unavailable render as fixed sentences", async () => {
    expect(renderRecallReadResult({ kind: "not_found" }, "research/x")).toBe(
      'Nothing named "research/x" exists in memory — and nothing similar.',
    );
    expect(
      renderRecallReadResult({ kind: "unavailable", note: "io" }, "records/2026-10-14-1836"),
    ).toContain("That is a read failure, not absence");
  });
});

// ─── Tree index + head helpers ─────────────────────────────────────────────

describe("buildTreeIndex", () => {
  it("filters config/, attachments, and the legacy settings file; collects slices and bare files", () => {
    const index = buildTreeIndex([
      "memory/config/settings.json",
      "memory/user/config.json",
      "memory/research/x/index.md",
      "memory/research/x/attachments/photo.png",
      "memory/records/2026/10/14/1836/core.md",
      "memory/records/2026/10/14/1836/agent.md",
      "memory/self/agenda.md",
      "memory/people/user/profile.md",
      "memory/episodic/slices/2026/10/01/0900/timeline/core.md",
    ]);
    expect(index.slices).toEqual(["2026-10-01-0900", "2026-10-14-1836"]);
    expect(index.agendaPath).toBe("memory/self/agenda.md");
    expect(index.profilePath).toBe("memory/people/user/profile.md");
    const allPaths = index.cases.flatMap((c) => [c.indexPath, ...c.pieces]).filter(Boolean);
    expect(allPaths.some((p) => p!.includes("attachments"))).toBe(false);
  });
});

describe("sliceHeadText", () => {
  it("keeps the frontmatter and the first body lines only", () => {
    const head = sliceHeadText(sliceCore("焦点", "正文", 60), 30);
    expect(head).toContain("focus: 焦点");
    expect(head).toContain("正文");
    expect(head).not.toContain("填充行 60");
  });
});
