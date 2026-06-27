import { describe, it, expect } from "vitest";
import { scoreNode, rankNodes } from "@/lib/memory/scorer";
import type { NodeMeta } from "@/lib/memory/types";

function makeNode(overrides: Partial<NodeMeta> = {}): NodeMeta {
  return {
    path: "memory/nodes/test.md",
    type: "concept",
    tags: ["test"],
    links: [],
    backlinks: [],
    priority: 5,
    access_count: 0,
    last_accessed: new Date().toISOString().split("T")[0],
    status: "active",
    ...overrides,
  };
}

describe("Memory Scorer", () => {
  it("high priority + keyword match ranks highest", () => {
    const high = makeNode({ priority: 9, tags: ["rust"], path: "high.md" });
    const low = makeNode({ priority: 5, tags: ["python"], path: "low.md" });

    const sHigh = scoreNode(high, "rust programming", "coding", new Set());
    const sLow = scoreNode(low, "rust programming", "coding", new Set());

    expect(sHigh).toBeGreaterThan(sLow);
  });

  it("keyword match adds +5 per matching tag", () => {
    const node = makeNode({ priority: 5, tags: ["rust", "ownership", "borrow"] });
    const score = scoreNode(node, "rust ownership concepts", "coding", new Set());
    // 5 base + 5*2 keyword = 15, with negligible same-day decay ≈ 14.8-15
    expect(score).toBeGreaterThan(14);
  });

  it("graph bonus adds +2 per linked node already selected", () => {
    const node = makeNode({
      path: "linked.md",
      priority: 5,
      links: ["already-picked-1", "already-picked-2"],
    });
    const selected = new Set(["already-picked-1", "already-picked-2"]);
    const score = scoreNode(node, "test", "coding", selected);
    expect(score).toBeGreaterThanOrEqual(9); // 5 base + 4 graph
  });

  it("time decay reduces stale nodes", () => {
    const fresh = makeNode({
      path: "fresh.md",
      priority: 8,
      last_accessed: new Date().toISOString().split("T")[0],
    });
    const stale = makeNode({
      path: "stale.md",
      priority: 8,
      last_accessed: "2026-01-01", // ~6 months ago
    });

    const now = new Date("2026-06-28");
    const sFresh = scoreNode(fresh, "test", "coding", new Set(), now);
    const sStale = scoreNode(stale, "test", "coding", new Set(), now);

    expect(sFresh).toBeGreaterThan(sStale);
  });

  it("frequency bonus is capped at +3", () => {
    // Use a unique query to avoid keyword match with tags
    const heavy = makeNode({ priority: 5, access_count: 100, tags: ["unique-tag"], path: "heavy.md" });
    const score = scoreNode(heavy, "completely different query", "coding", new Set());
    // max freq bonus = 3, so max score = 5 base + 3 freq = 8 (no keyword match, minimal decay)
    expect(score).toBeLessThanOrEqual(8.1);
  });

  it("deprecated nodes score 0", () => {
    const deprecated = makeNode({ status: "deprecated", path: "old.md" });
    const score = scoreNode(deprecated, "test", "coding", new Set());
    expect(score).toBe(0);
  });

  it("rankNodes returns top N within limit", () => {
    const nodes = [
      makeNode({ priority: 9, path: "high.md" }),
      makeNode({ priority: 7, path: "mid.md" }),
      makeNode({ priority: 3, path: "low.md" }),
    ];

    const ranked = rankNodes(nodes, "test", "coding", 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].priority).toBe(9);
    expect(ranked[1].priority).toBe(7);
  });
});
