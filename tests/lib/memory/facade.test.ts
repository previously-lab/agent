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
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import git from "isomorphic-git";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  recallRecent,
  recallFind,
  recallSearch,
  recallRead,
  recallSince,
  readChangesSince,
  renderRecallResult,
  renderRecallReadResult,
  renderRecallSinceResult,
  buildTreeIndex,
  sliceHeadText,
  firstProseLine,
  mapWithConcurrency,
  createReadCache,
  type RecallBackend,
  type RecallChangesRead,
  type RecallResult,
} from "@/lib/memory/facade";

// ─── recallSince (v0.11) — mocks over the storage-boundary modules ─────────
//
// Same discipline as tests/lib/chat/hq-log.test.ts: resolveDataSource /
// whitelist / github client / capabilities are mocked at the module boundary;
// local-git is the REAL module (the local fixture below is a genuine git
// repo, so the tree-diff walk runs for real).

const h = vi.hoisted(() => {
  const repos = {
    get: vi.fn(),
    listCommits: vi.fn(),
    compareCommits: vi.fn(),
  };
  return {
    source: "local" as string,
    memoryRoot: "/nonexistent-memory-root",
    octokit: { rest: { repos } },
    repos,
  };
});

vi.mock("@/lib/data-source/resolve", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/data-source/resolve")>();
  return { ...actual, resolveDataSource: () => h.source };
});
vi.mock("@/lib/whitelist", () => ({
  getMemoryRoot: () => h.memoryRoot,
}));
vi.mock("@/lib/github/client", () => ({
  getOctokit: () => h.octokit,
}));
vi.mock("@/lib/capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/capabilities")>();
  return { ...actual, getRepoConfig: () => ({ owner: "o", repo: "r" }) };
});

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

// ─── Approximate name matching (v0.11 — 只差一个空格的真机教训) ─────────────

const FUZZY_FILES: Record<string, string> = {
  // the real-machine case: stored with a space inside the full-width parens
  "memory/research/厄尔尼诺对我国天气的影响（2026 年秋冬）/index.md": `---
opened: 2026-10-01
updated: 2026-10-01T09:00:00.000Z
---

厄尔尼诺与东亚冬季风偏弱。
`,
  // a near-twin of the stored name — the "two very alike" ambiguity probe
  "memory/research/厄尔尼诺对我国天气的影响（2026 年秋冬报告）/index.md": `---
opened: 2026-10-02
updated: 2026-10-02T09:00:00.000Z
---

跟进报告版。
`,
  // CJK dashes + full-width parens + the 、 enumerator
  "memory/events/周末——爬山（待定）/index.md": `---
opened: 2026-09-20
updated: 2026-09-20T09:00:00.000Z
---

周末爬山计划。
`,
  "memory/tasks/买牛奶、鸡蛋/index.md": `---
opened: 2026-09-21
updated: 2026-09-21T09:00:00.000Z
---

购物清单。
`,
  // an English name — the case-fold probe
  "memory/things/iPhone 选购备忘录/index.md": `---
opened: 2026-09-22
updated: 2026-09-22T09:00:00.000Z
---

大小写不敏感。
`,
};

describe("approximate name matching (recallFind)", () => {
  const fuzzyBackend = () => makeBackend(FUZZY_FILES);
  // the 报告 twin excluded — the "one strong candidate" scenario
  const soloBackend = () =>
    makeBackend(
      Object.fromEntries(
        Object.entries(FUZZY_FILES).filter(
          ([p]) => !p.includes("年秋冬报告"),
        ),
      ),
    );

  it("adopts a unique strong candidate that differs only by a space (the real-machine case)", async () => {
    const r = await recallFind(soloBackend(), {
      category: "research",
      name: "厄尔尼诺对我国天气的影响（2026年秋冬）",
    });
    if (r.kind !== "entries") throw new Error(`expected entries, got ${r.kind}`);
    expect(r.entries[0]!.ref).toBe("research/厄尔尼诺对我国天气的影响（2026 年秋冬）");
    expect(r.matchedName).toBe("厄尔尼诺对我国天气的影响（2026 年秋冬）");
    const text = renderRecallResult(r, { category: "research", name: "厄尔尼诺对我国天气的影响（2026年秋冬）" });
    expect(text).toContain('(matched the near-name "厄尔尼诺对我国天气的影响（2026 年秋冬）"');
  });

  it("adopts across full/half-width parens, CJK dashes, and the 、 enumerator", async () => {
    const dash = await recallFind(fuzzyBackend(), {
      category: "events",
      name: "周末--爬山(待定)",
    });
    if (dash.kind !== "entries") throw new Error(`expected entries, got ${dash.kind}`);
    expect(dash.entries[0]!.ref).toBe("events/周末——爬山（待定）");
    const comma = await recallFind(fuzzyBackend(), {
      category: "tasks",
      name: "买牛奶,鸡蛋",
    });
    if (comma.kind !== "entries") throw new Error(`expected entries, got ${comma.kind}`);
    expect(comma.entries[0]!.ref).toBe("tasks/买牛奶、鸡蛋");
  });

  it("adopts across letter case (English name)", async () => {
    const r = await recallFind(fuzzyBackend(), {
      category: "things",
      name: "iphone 选购备忘录",
    });
    if (r.kind !== "entries") throw new Error(`expected entries, got ${r.kind}`);
    expect(r.entries[0]!.ref).toBe("things/iPhone 选购备忘录");
  });

  it("does NOT adopt when two candidates are both very alike — near misses sorted best-first", async () => {
    const r = await recallFind(fuzzyBackend(), {
      category: "research",
      name: "厄尔尼诺对我国天气的影响（2026年秋冬）",
    });
    // The base name scores 1.0, the 报告 twin ~0.96 — margin < 0.1, so the
    // field is ambiguous: no adoption, both come back as scored near misses.
    if (r.kind !== "not_found") throw new Error(`expected not_found, got ${r.kind}`);
    expect(r.nearMisses.map((e) => e.ref)).toEqual([
      "research/厄尔尼诺对我国天气的影响（2026 年秋冬）",
      "research/厄尔尼诺对我国天气的影响（2026 年秋冬报告）",
    ]);
  });

  it("returns not_found with an empty near-miss list for an unrelated name", async () => {
    const r = await recallFind(fuzzyBackend(), { category: "research", name: "量子引力波探测" });
    expect(r).toEqual({ kind: "not_found", nearMisses: [] });
  });

  it("exact matches still win verbatim — regression (no matchedName attached)", async () => {
    const r = await recallFind(fuzzyBackend(), {
      category: "events",
      name: "周末——爬山（待定）",
    });
    if (r.kind !== "entries") throw new Error(`expected entries, got ${r.kind}`);
    expect(r.matchedName).toBeUndefined();
    expect(renderRecallResult(r, { category: "events" })).not.toContain("matched the near-name");
  });
});

describe("approximate name matching (recallRead)", () => {
  const fuzzyBackend = () => makeBackend(FUZZY_FILES);
  // the 报告 twin excluded — the "one strong candidate" scenario
  const soloBackend = () =>
    makeBackend(
      Object.fromEntries(
        Object.entries(FUZZY_FILES).filter(
          ([p]) => !p.includes("年秋冬报告"),
        ),
      ),
    );

  it("resolves an approximate ref and reads it, reporting the stored ref", async () => {
    const r = await recallRead(soloBackend(), {
      ref: "research/厄尔尼诺对我国天气的影响（2026年秋冬）",
    });
    if (r.kind !== "content") throw new Error(`expected content, got ${r.kind}`);
    expect(r.content).toContain("厄尔尼诺与东亚冬季风偏弱。");
    expect(r.matchedRef).toBe("research/厄尔尼诺对我国天气的影响（2026 年秋冬）");
    const text = renderRecallReadResult(r, "research/厄尔尼诺对我国天气的影响（2026年秋冬）");
    expect(text.startsWith('(matched the near-name "research/厄尔尼诺对我国天气的影响（2026 年秋冬）"')).toBe(true);
  });

  it("an ambiguous approximate ref returns not_found with scored near misses", async () => {
    const r = await recallRead(fuzzyBackend(), {
      ref: "research/厄尔尼诺对我国天气的影响（2026年冬）",
    });
    if (r.kind !== "not_found") throw new Error(`expected not_found, got ${r.kind}`);
    const refs = r.nearMisses?.map((e) => e.ref) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    // best-first: the shorter base name outranks the 报告 twin
    expect(refs[0]).toBe("research/厄尔尼诺对我国天气的影响（2026 年秋冬）");
    const text = renderRecallReadResult(r, "research/厄尔尼诺对我国天气的影响（2026年冬）");
    expect(text).toContain("Closest matches:");
  });
});

// ─── Verb ④ recallRead — outline mode ──────────────────────────────────────

describe("recallRead outline", () => {
  /** 12 lines, three headings across levels (1-based numbering below). */
  const OUTLINE_DOC = [
    "# 调研笔记", // 1
    "", // 2
    "开篇。", // 3
    "", // 4
    "## 报价", // 5
    "三家报价。", // 6
    "", // 7
    "### 明细", // 8
    "- 明细一", // 9
    "", // 10
    "## 结论", // 11
    "定论。", // 12
  ].join("\n");

  const FENCE_DOC = [
    "# 真标题", // 1
    "", // 2
    "```md", // 3
    "# 围栏里的井号", // 4 — not a heading
    "```", // 5
    "", // 6
    "## 第二个", // 7
    "body", // 8
  ].join("\n");

  const NO_HEADING_DOC = ["没有标题的第一行。", "", "第二段。"].join("\n");

  const outlineBackend = () =>
    makeBackend({
      "memory/research/大纲测试/index.md": OUTLINE_DOC,
      "memory/research/围栏测试/index.md": FENCE_DOC,
      "memory/things/平文档/index.md": NO_HEADING_DOC,
    });

  it("returns the heading skeleton with exact 1-based spans", async () => {
    const r = await recallRead(outlineBackend(), { ref: "research/大纲测试", outline: true });
    if (r.kind !== "outline") throw new Error(`expected outline, got ${r.kind}`);
    expect(r.ref).toBe("research/大纲测试");
    expect(r.totalLines).toBe(12);
    expect(r.headings).toEqual([
      { level: 1, title: "调研笔记", from: 1, to: 4 },
      { level: 2, title: "报价", from: 5, to: 7 },
      { level: 3, title: "明细", from: 8, to: 10 },
      { level: 2, title: "结论", from: 11, to: 12 },
    ]);
    const text = renderRecallReadResult(r, "research/大纲测试");
    expect(text).toContain("range: \"lines:a-b\"");
    expect(text).toContain("L5-7  报价");
  });

  it("does not treat fenced `#` lines as headings", async () => {
    const r = await recallRead(outlineBackend(), { ref: "research/围栏测试", outline: true });
    if (r.kind !== "outline") throw new Error(`expected outline, got ${r.kind}`);
    expect(r.headings).toEqual([
      { level: 1, title: "真标题", from: 1, to: 6 },
      { level: 2, title: "第二个", from: 7, to: 8 },
    ]);
  });

  it("a document with no headings returns an empty skeleton and the fixed note", async () => {
    const r = await recallRead(outlineBackend(), { ref: "things/平文档", outline: true });
    if (r.kind !== "outline") throw new Error(`expected outline, got ${r.kind}`);
    expect(r.headings).toEqual([]);
    const text = renderRecallReadResult(r, "things/平文档");
    expect(text).toContain("no heading skeleton");
    expect(text).toContain("range: \"lines:a-b\"");
  });

  it("outline omitted reads the body exactly as before", async () => {
    const withOutline = await recallRead(outlineBackend(), { ref: "research/大纲测试", outline: false });
    const without = await recallRead(outlineBackend(), { ref: "research/大纲测试" });
    for (const r of [withOutline, without]) {
      if (r.kind !== "content") throw new Error(`expected content, got ${r.kind}`);
      expect(r.content).toBe(OUTLINE_DOC);
    }
  });
});

// ─── Verb ⑤ recallSince — the differential view (v0.11) ────────────────────

/** One commit in a REAL local git fixture (timestamps pinned via author). */
async function fixtureCommit(
  root: string,
  files: Record<string, string>,
  message: string,
  iso: string,
): Promise<string> {
  const fs = await import("fs");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    await git.add({ fs, dir: root, filepath: rel });
  }
  return git.commit({
    fs,
    dir: root,
    message,
    author: {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: Math.floor(Date.parse(iso) / 1000),
    },
  });
}

describe("recallSince — local git fixture (real tree diffs)", () => {
  const fixtureRoots: string[] = [];

  async function makeFixture(): Promise<{
    root: string;
    shas: { c1: string; c2: string; c3: string };
  }> {
    const root = mkdtempSync(join(tmpdir(), "recall-since-"));
    fixtureRoots.push(root);
    await git.init({ fs: await import("fs"), dir: root });
    // c1 (2026-10-10): a slice (core + agent) + a config file (filtered later)
    const c1 = await fixtureCommit(
      root,
      {
        "records/2026/10/10/0900/core.md": "core",
        "records/2026/10/10/0900/agent.md": "agent",
        "config/settings.json": "{}",
      },
      "slice + config",
      "2026-10-10T10:00:00.000Z",
    );
    // c2 (2026-10-12): a case opens
    const c2 = await fixtureCommit(
      root,
      { "events/手机/index.md": "# 手机\n" },
      "open case",
      "2026-10-12T09:00:00.000Z",
    );
    // c3 (2026-10-14): the case updates + a research case opens
    const c3 = await fixtureCommit(
      root,
      {
        "events/手机/index.md": "# 手机\n\nupdated\n",
        "research/调研/index.md": "# 调研\n",
      },
      "update + open research",
      "2026-10-14T08:00:00.000Z",
    );
    h.memoryRoot = root;
    h.source = "local";
    return { root, shas: { c1, c2, c3 } };
  }

  afterAll(() => {
    for (const root of fixtureRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    h.memoryRoot = "/nonexistent-memory-root";
  });

  it("since-filtering + newest-first ordering: the window closes at the first older commit", async () => {
    const { shas } = await makeFixture();
    const read = await readChangesSince({ since: "2026-10-12" });
    expect(read.unavailable).toBeUndefined();
    expect(read.commits.map((c) => c.sha)).toEqual([shas.c3, shas.c2]);

    const result = recallSince(read, {});
    if (result.kind !== "changes") throw new Error(`expected changes, got ${result.kind}`);
    // c3's files come first; the c2 "added" of events/手机 collapses under
    // c3's newer "modified" (first occurrence — the newest touch — wins).
    expect(result.entries).toEqual([
      { ref: "events/手机", change: "modified", at: "2026-10-14T08:00:00.000Z" },
      { ref: "research/调研", change: "added", at: "2026-10-14T08:00:00.000Z" },
    ]);
    // c1's slice and config are outside the window entirely.
    expect(result.entries.some((e) => e.ref.startsWith("records/"))).toBe(false);
  });

  it("slice files collapse into ONE records ref, config/ is filtered, category + limit cap ENTRIES", async () => {
    await makeFixture();
    const read = await readChangesSince({ since: "2026-10-10" });
    const result = recallSince(read, {});
    if (result.kind !== "changes") throw new Error(`expected changes, got ${result.kind}`);
    const refs = result.entries.map((e) => e.ref);
    // core.md + agent.md of one slice → exactly one records ref…
    expect(refs.filter((r) => r === "records/2026-10-10-0900")).toHaveLength(1);
    // …config/settings.json never becomes an entry…
    expect(refs.some((r) => r.includes("config"))).toBe(false);
    expect(result.total).toBe(3);

    const recordsOnly = recallSince(read, { category: "records" });
    if (recordsOnly.kind !== "changes") throw new Error(`expected changes, got ${recordsOnly.kind}`);
    expect(recordsOnly.entries.map((e) => e.ref)).toEqual(["records/2026-10-10-0900"]);

    const capped = recallSince(read, { limit: 1 });
    if (capped.kind !== "changes") throw new Error(`expected changes, got ${capped.kind}`);
    expect(capped.entries).toHaveLength(1);
    expect(capped.total).toBe(3);
    expect(capped.cursor).toBe(read.commits[read.commits.length - 1]!.sha);
    const text = renderRecallSinceResult(capped);
    expect(text).toContain("pass cursor=");
    expect(text).toContain("Showing the newest 1 of 3 changed entries");
  });
});

describe("recallSince — GitHub backend (compare-once discipline)", () => {
  beforeEach(() => {
    h.source = "github";
    vi.clearAllMocks();
  });

  const COMPARE = {
    total_commits: 2,
    commits: [
      { sha: "a1", commit: { committer: { date: "2026-10-13T10:00:00Z" } } },
      { sha: "b2", commit: { committer: { date: "2026-10-15T10:00:00Z" } } },
    ],
    files: [
      { filename: "memory/events/手机/index.md", status: "modified" },
      { filename: "memory/records/2026/10/14/1836/core.md", status: "added" },
      { filename: "memory/config/settings.json", status: "modified" },
    ],
    merge_base_commit: { sha: "base-sha" },
  };

  it("ONE compareCommits call (plus base lookup), entries shaped, config filtered", async () => {
    h.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
    h.repos.listCommits.mockResolvedValue({ data: [{ sha: "base-sha" }] });
    h.repos.compareCommits.mockResolvedValue({ data: COMPARE });

    const read = await readChangesSince({ since: "2026-10-12" });
    expect(h.repos.compareCommits).toHaveBeenCalledTimes(1);
    expect(h.repos.compareCommits).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      base: "base-sha",
      head: "main",
    });
    expect(h.repos.listCommits).toHaveBeenCalledTimes(1);
    expect(h.repos.listCommits.mock.calls[0]![0]).toMatchObject({
      until: "2026-10-12T00:00:00Z",
      per_page: 1,
    });

    const result = recallSince(read, {});
    if (result.kind !== "changes") throw new Error(`expected changes, got ${result.kind}`);
    expect(result.commits).toBe(2); // the range total, not the pseudo-commit count
    expect(result.incomplete).toBe(false);
    expect(result.entries).toEqual([
      { ref: "events/手机", change: "modified", at: "2026-10-15T10:00:00Z" },
      { ref: "records/2026-10-14-1836", change: "added", at: "2026-10-15T10:00:00Z" },
    ]);
  });

  it("a truncated compare is INCOMPLETE (never 'no changes'); an empty range renders the empty window", async () => {
    h.repos.get.mockResolvedValue({ data: { default_branch: "main" } });
    h.repos.listCommits.mockResolvedValue({ data: [] }); // young repo → empty-tree base
    const truncatedFiles = Array.from({ length: 300 }, (_, i) => ({
      filename: `memory/events/case-${i}/index.md`,
      status: "added",
    }));
    h.repos.compareCommits.mockResolvedValue({
      data: {
        total_commits: 400,
        commits: Array.from({ length: 250 }, (_, i) => ({
          sha: `c${i}`,
          commit: { committer: { date: "2026-10-15T10:00:00Z" } },
        })),
        files: truncatedFiles,
        merge_base_commit: { sha: "empty-base" },
      },
    });

    const read = await readChangesSince({ since: "2026-10-12" });
    expect(read.incomplete).toBe(true);
    const result = recallSince(read, { limit: 50 });
    if (result.kind !== "changes") throw new Error(`expected changes, got ${result.kind}`);
    expect(result.incomplete).toBe(true);
    const text = renderRecallSinceResult(result);
    expect(text).toContain("This result is INCOMPLETE");
    expect(h.repos.compareCommits).toHaveBeenCalledTimes(1);

    // …and the genuinely-empty window is a different, honest sentence.
    h.repos.compareCommits.mockResolvedValue({
      data: { total_commits: 0, commits: [], files: [], merge_base_commit: { sha: "x" } },
    });
    const emptyRead = await readChangesSince({ since: "2026-10-12" });
    const empty = recallSince(emptyRead, {});
    expect(empty.kind).toBe("empty");
    // `until` falls back to the range-end day (today when the backend says
    // nothing) — assert the fixed sentence, not the rolling date.
    const emptyText = renderRecallSinceResult(empty);
    expect(emptyText).toContain("No changes since 2026-10-12 through ");
    expect(emptyText).toContain(
      "— the commit history shows nothing in this window.",
    );
  });
});

describe("recallSince — pure shaping over a synthetic read", () => {
  const read: RecallChangesRead = {
    since: "2026-10-12",
    until: "2026-10-15",
    incomplete: false,
    commits: [
      {
        sha: "new",
        at: "2026-10-15T09:00:00.000Z",
        files: [
          { path: "records/2026/10/15/0831/core.md", change: "added" },
          { path: "records/2026/10/15/0831/previously.md", change: "added" },
          { path: "self/agenda.md", change: "modified" },
          { path: "docs/notes.md", change: "added" }, // no recallRead shape → dropped
        ],
      },
      {
        sha: "old",
        at: "2026-10-13T09:00:00.000Z",
        files: [{ path: "people/user/profile.md", change: "modified" }],
      },
    ],
  };

  it("collapses the slice parts to one ref, drops unshaped paths, timeline reads records", () => {
    const all = recallSince(read, {});
    if (all.kind !== "changes") throw new Error(`expected changes, got ${all.kind}`);
    expect(all.entries.map((e) => e.ref)).toEqual([
      "records/2026-10-15-0831",
      "self/agenda",
      "people/user/profile",
    ]);
    expect(all.commits).toBe(2);

    const timeline = recallSince(read, { category: "timeline" });
    if (timeline.kind !== "changes") throw new Error(`expected changes, got ${timeline.kind}`);
    expect(timeline.entries.map((e) => e.ref)).toEqual(["records/2026-10-15-0831"]);
  });
});


// ─── Bounded concurrency + read cache (recall latency fix) ─────────────────

describe("mapWithConcurrency", () => {
  const delayed =
    (ms: number) =>
    async <T>(v: T): Promise<T> => {
      await new Promise((r) => setTimeout(r, ms));
      return v;
    };

  it("keeps input order regardless of completion order", async () => {
    // Later items finish FIRST (0 ms) while early items lag — output must
    // still match input order.
    const out = await mapWithConcurrency([50, 10, 30], 3, async (n) => {
      await new Promise((r) => setTimeout(r, 60 - n));
      return n * 2;
    });
    expect(out).toEqual([100, 20, 60]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delayed(5)(null);
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(out).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("caps lanes at the item count and handles empty input", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1], 8, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1]);
    expect(await mapWithConcurrency([], 8, delayed(0))).toEqual([]);
  });
});

describe("createReadCache", () => {
  function countingBackend(files: Record<string, string>): {
    backend: RecallBackend;
    calls: Map<string, number>;
  } {
    const calls = new Map<string, number>();
    const backend: RecallBackend = {
      listMemoryFiles: async () => Object.keys(files).sort(),
      readFile: async (path: string) => {
        calls.set(path, (calls.get(path) ?? 0) + 1);
        const v = files[path];
        if (v === undefined) throw new Error(`File not found: "${path}"`);
        return v;
      },
    };
    return { backend, calls };
  }

  it("serves repeat reads inside the TTL with zero underlying calls", async () => {
    const { backend, calls } = countingBackend({ "memory/self/agenda.md": "# agenda" });
    const cached = createReadCache(backend);
    const a = await cached.readFile("memory/self/agenda.md");
    const b = await cached.readFile("memory/self/agenda.md");
    expect(a).toBe(b);
    expect(calls.get("memory/self/agenda.md")).toBe(1);
    // passthrough for the other primitive
    expect(await cached.listMemoryFiles()).toEqual(["memory/self/agenda.md"]);
  });

  it("re-reads after the TTL window", async () => {
    vi.useFakeTimers();
    try {
      const { backend, calls } = countingBackend({ "memory/self/agenda.md": "# agenda" });
      const cached = createReadCache(backend);
      await cached.readFile("memory/self/agenda.md");
      vi.setSystemTime(Date.now() + 29_000);
      await cached.readFile("memory/self/agenda.md");
      expect(calls.get("memory/self/agenda.md")).toBe(1);
      vi.setSystemTime(Date.now() + 31_000);
      await cached.readFile("memory/self/agenda.md");
      expect(calls.get("memory/self/agenda.md")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest entry past the capacity cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 202; i += 1) files[`memory/self/f${i}.md`] = `body ${i}`;
    const { backend, calls } = countingBackend(files);
    const cached = createReadCache(backend);
    for (let i = 0; i < 200; i += 1) await cached.readFile(`memory/self/f${i}.md`);
    // Two more inserts push f0 and f1 out (cap 200, insertion-order eviction).
    await cached.readFile("memory/self/f200.md");
    await cached.readFile("memory/self/f201.md");
    expect(calls.get("memory/self/f0.md")).toBe(1);
    await cached.readFile("memory/self/f0.md"); // evicted → backend again
    expect(calls.get("memory/self/f0.md")).toBe(2);
    // f199 is still inside → no extra call.
    await cached.readFile("memory/self/f199.md");
    expect(calls.get("memory/self/f199.md")).toBe(1);
  });

  it("does not cache failures", async () => {
    const { backend, calls } = countingBackend({});
    const cached = createReadCache(backend);
    await expect(cached.readFile("memory/self/nope.md")).rejects.toThrow("File not found");
    await expect(cached.readFile("memory/self/nope.md")).rejects.toThrow("File not found");
    expect(calls.get("memory/self/nope.md")).toBe(2);
  });
});

describe("recall verbs read with bounded concurrency", () => {
  it("recallSearch caps in-flight reads and preserves hit order", async () => {
    // 12 case index files, all containing the keyword; the scan must fan out
    // no wider than the concurrency ceiling and return hits newest-first.
    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i += 1) {
      const day = String(i).padStart(2, "0");
      files[`memory/people/case-${day}/index.md`] =
        `---\nopened: 2026-09-${day}\nupdated: 2026-09-${day}T10:00:00.000Z\n---\n\n关键词 body ${i}`;
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const backend: RecallBackend = {
      listMemoryFiles: async () => Object.keys(files).sort(),
      readFile: async (path: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        const v = files[path];
        if (v === undefined) throw new Error(`File not found: "${path}"`);
        return v;
      },
    };
    const r = await recallSearch(backend, { query: "关键词" });
    expect(r.kind).toBe("entries");
    if (r.kind !== "entries") return;
    expect(r.entries).toHaveLength(12);
    // Newest-first by activity date (case-12 = 2026-09-12 first).
    expect(r.entries[0]!.ref).toBe("people/case-12");
    expect(r.entries[11]!.ref).toBe("people/case-01");
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1); // actually concurrent, not serial
  });
});
