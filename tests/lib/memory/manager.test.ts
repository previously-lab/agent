import { describe, it, expect, beforeEach } from "vitest";
import { parseNode, buildIndex, listNodes, getNodeMeta, clearCache } from "@/lib/memory/manager";

const sampleNode = `---
id: "test-node"
type: "concept"
domain: "test"
tags: ["unit-test", "memory"]
related: ["other-node"]
backlinks: []
priority: 8
access_count: 3
last_accessed: "2026-06-27"
recall_conditions:
  - "query contains 'test'"
status: "active"
---

# Test Node

This is a test memory node.

## Details
More content here.
`;

describe("Memory Manager", () => {
  beforeEach(() => {
    clearCache();
  });

  it("parses a valid memory node", () => {
    const node = parseNode(sampleNode);
    expect(node.id).toBe("test-node");
    expect(node.type).toBe("concept");
    expect(node.tags).toContain("unit-test");
    expect(node.priority).toBe(8);
    expect(node.content).toContain("test memory node");
    expect(node.recall_conditions).toHaveLength(1);
  });

  it("uses defaults for missing fields", () => {
    const minimal = `---
id: minimal
---`;
    const node = parseNode(minimal);
    expect(node.id).toBe("minimal");
    expect(node.type).toBe("concept");
    expect(node.priority).toBe(5);
    expect(node.tags).toEqual([]);
  });

  it("rejects node without id by skipping in buildIndex", () => {
    const invalid = `---
type: concept
---
No id here`;
    const index = buildIndex({ "memory/nodes/concepts/invalid.md": invalid });
    expect(Object.keys(index.nodes)).toHaveLength(0);
  });

  it("builds index from multiple files", () => {
    const files = {
      "memory/nodes/concepts/a.md": sampleNode,
      "memory/nodes/experience/b.md": `---
id: "exp-node"
type: "experience"
tags: ["learned"]
priority: 6
---
# Experience`,
    };

    const index = buildIndex(files);
    expect(Object.keys(index.nodes)).toHaveLength(2);
    expect(index.nodes["test-node"].type).toBe("concept");
    expect(index.nodes["exp-node"].type).toBe("experience");
  });

  it("lists nodes filtered by type", () => {
    const files = {
      "a.md": sampleNode,
      "b.md": `---
id: "exp-node"
type: "experience"
tags: ["learned"]
priority: 6
---`,
    };
    buildIndex(files);

    const concepts = listNodes({ types: ["concept"] });
    expect(concepts).toHaveLength(1);
    expect(concepts[0].type).toBe("concept");
  });

  it("lists nodes filtered by tags", () => {
    const files = {
      "a.md": sampleNode,
      "b.md": `---
id: "exp-node"
type: "experience"
tags: ["learned", "test"]
priority: 6
---`,
    };
    buildIndex(files);

    const tagged = listNodes({ tags: ["unit-test"] });
    expect(tagged).toHaveLength(1);
  });

  it("returns null for non-existent node", () => {
    buildIndex({ "test.md": sampleNode });
    expect(getNodeMeta("non-existent")).toBeNull();
  });
});
