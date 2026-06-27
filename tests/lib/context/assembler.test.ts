import { describe, it, expect } from "vitest";
import { assembleContext } from "@/lib/context/assembler";
import type { MemoryNode, NodeMeta } from "@/lib/memory/types";

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "test-node",
    type: "concept",
    domain: "test",
    tags: ["test"],
    related: [],
    backlinks: [],
    priority: 5,
    access_count: 0,
    last_accessed: "2026-06-27",
    status: "active",
    title: "Test Node",
    content: "## Section\n\nThis is test content for the memory node.\n\nMore text here.",
    ...overrides,
  };
}

function makeMeta(id: string): NodeMeta {
  return {
    path: `memory/nodes/concepts/${id}.md`,
    type: "concept",
    tags: ["test"],
    links: [],
    backlinks: [],
    priority: 5,
    access_count: 0,
    last_accessed: "2026-06-27",
    status: "active",
  };
}

describe("Context Assembler", () => {
  it("assembles all 6 layers in order", () => {
    const core = [makeNode({ id: "core-1", title: "Core Node" })];
    const extended = [makeNode({ id: "ext-1", title: "Extended Node" })];
    const reference = [makeMeta("ref-1"), makeMeta("ref-2")];

    const result = assembleContext({
      systemPrompt: "You are a helpful assistant.",
      coreNodes: core,
      extendedNodes: extended,
      referenceNodes: reference,
      sessionSummary: "Working on a test.",
      recentTurns: [{ role: "user", content: "Hello" }],
      userInput: "What is this?",
    });

    expect(result.prompt).toContain("You are a helpful assistant");
    expect(result.prompt).toContain("Core Node");
    expect(result.prompt).toContain("Extended Node");
    expect(result.prompt).toContain("Session Summary");
    expect(result.prompt).toContain("Hello");
    expect(result.prompt).toContain("What is this?");
    expect(result.prompt).toContain("ref-1");
    expect(result.prompt).toContain("ref-2");
  });

  it("includes related topics section for reference nodes", () => {
    const result = assembleContext({
      systemPrompt: "System",
      coreNodes: [],
      extendedNodes: [],
      referenceNodes: [makeMeta("rust-ownership")],
      sessionSummary: "",
      recentTurns: [],
      userInput: "test",
    });

    expect(result.prompt).toContain("Related Topics");
    expect(result.prompt).toContain("rust-ownership");
  });

  it("estimates token counts", () => {
    const result = assembleContext({
      systemPrompt: "Hello world.",
      coreNodes: [makeNode({ content: "Some content here." })],
      extendedNodes: [],
      referenceNodes: [],
      sessionSummary: "",
      recentTurns: [],
      userInput: "test",
    });

    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.layers.system).toBeGreaterThan(0);
    expect(result.layers.core).toBeGreaterThan(0);
    expect(result.layers.input).toBeGreaterThan(0);
  });

  it("truncates extended nodes when budget exceeded", () => {
    const hugeNode = makeNode({
      id: "huge",
      content: "X".repeat(50000), // would be ~12500 tokens alone
    });

    const result = assembleContext({
      systemPrompt: "System",
      coreNodes: [],
      extendedNodes: [hugeNode],
      referenceNodes: [],
      sessionSummary: "",
      recentTurns: [],
      userInput: "test",
      tokenBudget: 1000,
    });

    // Extended node should be truncated to fit budget
    expect(result.tokenEstimate).toBeLessThan(1500);
  });
});
