import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

// In-memory I/O for the entity-file layer: fsReadFile serves seeded entity
// files (throws when absent, like the real backends), fsWriteFile records.
const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  written: [] as Array<{ path: string; content: string }>,
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    io.written.push({ path, content });
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async () => {
    throw new Error("not used in consolidator tests");
  }),
}));

import { consolidateStrands } from "@/lib/episodic/flash/strand-consolidator";
import {
  gateStrandDescriptionRefresh,
  refreshStrandDescription,
  refreshStrandDescriptions,
} from "@/lib/episodic/flash/strand-consolidator";
import { serializeStrandEntity } from "@/lib/episodic/strand-files";
import type { ModelConfig } from "@/lib/models/registry";

/** A StreamTextResult stand-in resolving to the given tool calls. */
function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

const model: ModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
};

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.written.length = 0;
});

/** Build an index large enough to trigger the LLM pass (>= MIN_STRANDS_FOR_LLM). */
function bigIndex(): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (let i = 0; i < 30; i++) {
    idx[`topic-${i}`] = [`2026/08/0${(i % 7) + 1}/000${i % 10}`];
  }
  return idx;
}

describe("consolidateStrands", () => {
  it("always runs deterministic pruning, even when the LLM pass is skipped", async () => {
    // Tiny index → llmPassSkipped, but stale single-use strands still pruned.
    const now = Date.UTC(2026, 7, 7, 12, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const strands = {
      stale: ["2026/07/01/0800"], // old + single-use → pruned
      fresh: ["2026/08/06/0800"], // recent + single-use → kept
    };
    const result = await consolidateStrands(strands, model);
    expect(result.llmPassSkipped).toBe(true);
    expect(result.pruned).toEqual(["stale"]);
    expect(result.strands).toEqual({ fresh: ["2026/08/06/0800"] });
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("applies worker-proposed merges and removes the from key", async () => {
    const strands = bigIndex();
    strands["陈勇超"] = ["2026/08/02/0952"];
    strands["陈永超"] = ["2026/08/02/1050"];

    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "consolidateOutput",
          input: {
            merges: [{ from: "陈勇超", to: "陈永超", reason: "typo" }],
            reasoning: "same person, typo",
          },
        },
      ]),
    );

    const result = await consolidateStrands(strands, model);
    expect(result.llmPassSkipped).toBe(false);
    expect(result.merges).toEqual([{ from: "陈勇超", to: "陈永超", reason: "typo" }]);
    expect(result.strands["陈永超"]).toContain("2026/08/02/0952");
    expect(result.strands["陈勇超"]).toBeUndefined();
  });

  it("drops a proposal whose `to` key does not exist in the index", async () => {
    const strands = bigIndex();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "consolidateOutput",
          input: {
            merges: [{ from: "topic-0", to: "不存在", reason: "bad target" }],
            reasoning: "",
          },
        },
      ]),
    );

    const result = await consolidateStrands(strands, model);
    // No merges applied, no crash.
    expect(result.merges).toEqual([]);
    expect(result.strands["topic-0"]).toBeDefined();
  });

  it("returns the index unchanged when the worker fails", async () => {
    const strands = bigIndex();
    ai.streamText.mockRejectedValue(new Error("worker down"));

    const result = await consolidateStrands(strands, model);
    expect(result.merges).toEqual([]);
    expect(result.strands).toBeDefined();
    expect(Object.keys(result.strands).length).toBeGreaterThan(0);
  });

  it("returns an empty merge list when the worker reports no duplicates", async () => {
    const strands = bigIndex();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "consolidateOutput",
          input: { merges: [], reasoning: "index already clean" },
        },
      ]),
    );

    const result = await consolidateStrands(strands, model);
    expect(result.merges).toEqual([]);
  });
});

// ─── Strand entity description gating ─────────────────────────────────────

const NOW = Date.UTC(2026, 7, 20, 12, 0); // 2026-08-20

function seededEntity(name: string, lastActive: string) {
  io.files.set(
    `memory/episodic/strands/${name}.md`,
    serializeStrandEntity({
      name,
      first_seen: "2026-07-14",
      last_active: lastActive,
      aliases: [],
      description: "旧描述。",
    }),
  );
}

function descriptionToolCall(description: string) {
  return streamWith([
    {
      toolName: "strandDescriptionOutput",
      input: { description, aliases: ["alias-1"], reasoning: "ok" },
    },
  ]);
}

describe("gateStrandDescriptionRefresh", () => {
  it("allows a first description at >= 5 total slices and returns the slice ids", () => {
    const paths = [
      "2026/08/01/0900",
      "2026/08/03/1000",
      "2026/08/05/1100",
      "2026/08/07/1200",
      "2026/08/09/1300",
    ];
    const gate = gateStrandDescriptionRefresh({ entity: null, paths, nowMs: NOW });
    expect(gate).toEqual({
      ok: true,
      newSliceIds: [
        "2026-08-01-0900",
        "2026-08-03-1000",
        "2026-08-05-1100",
        "2026-08-07-1200",
        "2026-08-09-1300",
      ],
    });
  });

  it("blocks a first description below 5 slices", () => {
    const paths = ["2026/08/01/0900", "2026/08/03/1000", "2026/08/05/1100"];
    const gate = gateStrandDescriptionRefresh({ entity: null, paths, nowMs: NOW });
    expect(gate.ok).toBe(false);
  });

  it("counts only slices NEWER than last_active for a refresh", () => {
    const entity = {
      name: "x",
      first_seen: "2026-07-01",
      last_active: "2026-08-01",
      aliases: [],
      description: "旧描述。",
    };
    const paths = [
      "2026/07/15/0900", // old — not counted
      "2026/08/01/0900", // == last_active — not counted (strictly newer)
      "2026/08/02/0900",
      "2026/08/03/0900",
      "2026/08/04/0900",
      "2026/08/05/0900",
      "2026/08/06/0900", // 5 new
    ];
    const gate = gateStrandDescriptionRefresh({ entity, paths, nowMs: NOW });
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.newSliceIds).toHaveLength(5);
  });

  it("enforces the 7-day cooldown against last_active even with enough new slices", () => {
    const entity = {
      name: "x",
      first_seen: "2026-07-01",
      last_active: "2026-08-18", // 2 days before NOW
      aliases: [],
      description: "旧描述。",
    };
    const paths = [
      "2026/08/18/0900",
      "2026/08/19/0900",
      "2026/08/19/1000",
      "2026/08/20/0900",
      "2026/08/20/0910",
      "2026/08/20/0920", // 5 new, but within cooldown
    ];
    const gate = gateStrandDescriptionRefresh({ entity, paths, nowMs: NOW });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("cooldown");
  });

  it("passes once the cooldown has elapsed", () => {
    const entity = {
      name: "x",
      first_seen: "2026-07-01",
      last_active: "2026-08-10", // 10 days before NOW
      aliases: [],
      description: "旧描述。",
    };
    const paths = [
      "2026/08/10/0900",
      "2026/08/11/0900",
      "2026/08/12/0900",
      "2026/08/13/0900",
      "2026/08/14/0900",
      "2026/08/15/0900", // 5 new, cooldown elapsed
    ];
    const gate = gateStrandDescriptionRefresh({ entity, paths, nowMs: NOW });
    expect(gate.ok).toBe(true);
  });

  it("ignores malformed slice paths", () => {
    const gate = gateStrandDescriptionRefresh({
      entity: null,
      paths: [
        "not-a-path",
        "2026/08/01/0900",
        "2026/08/02/0900",
        "2026/08/03/0900",
        "2026/08/04/0900",
        "2026/08/05/0900",
      ],
      nowMs: NOW,
    });
    expect(gate.ok).toBe(true);
  });
});

describe("refreshStrandDescription", () => {
  it("refuses an update with no evidence slice ids", async () => {
    const result = await refreshStrandDescription({
      name: "x",
      sliceIds: [],
      paths: ["2026/08/01/0900"],
      model,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("evidence required");
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("refuses when the gate blocks (fewer than 5 new slices)", async () => {
    const result = await refreshStrandDescription({
      name: "x",
      sliceIds: ["2026-08-01-0900"],
      paths: ["2026/08/01/0900"],
      model,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("refuses when the caller's sliceIds do not match the fresh set the gate found", async () => {
    const paths = [
      "2026/08/01/0900",
      "2026/08/02/0900",
      "2026/08/03/0900",
      "2026/08/04/0900",
      "2026/08/05/0900",
    ];
    const result = await refreshStrandDescription({
      name: "x",
      // Stale evidence: id not in the fresh set.
      sliceIds: ["2026-07-01-0900", "2026-08-01-0900", "2026-08-02-0900", "2026-08-03-0900", "2026-08-04-0900"],
      paths,
      model,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("do not match");
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("writes the entity file on a successful refresh (dates mechanical, description from the model)", async () => {
    ai.streamText.mockResolvedValue(descriptionToolCall("新描述，基于新切片。"));
    const paths = [
      "2026/08/01/0900",
      "2026/08/03/1000",
      "2026/08/05/1100",
      "2026/08/07/1200",
      "2026/08/09/1300",
    ];
    const result = await refreshStrandDescription({
      name: "面试复盘",
      sliceIds: [
        "2026-08-01-0900",
        "2026-08-03-1000",
        "2026-08-05-1100",
        "2026-08-07-1200",
        "2026-08-09-1300",
      ],
      paths,
      model,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    expect(io.written).toHaveLength(1);
    expect(io.written[0].path).toBe("memory/episodic/strands/面试复盘.md");
    const written = io.files.get(io.written[0].path)!;
    expect(written).toContain("新描述，基于新切片。");
    // gray-matter quotes bare dates so they round-trip as strings.
    expect(written).toContain("first_seen: '2026-08-01'");
    expect(written).toContain("last_active: '2026-08-09'");
  });

  it("writes nothing when the LLM pass produces no description", async () => {
    ai.streamText.mockRejectedValue(new Error("worker down"));
    const paths = [
      "2026/08/01/0900",
      "2026/08/03/1000",
      "2026/08/05/1100",
      "2026/08/07/1200",
      "2026/08/09/1300",
    ];
    const result = await refreshStrandDescription({
      name: "x",
      sliceIds: [
        "2026-08-01-0900",
        "2026-08-03-1000",
        "2026-08-05-1100",
        "2026-08-07-1200",
        "2026-08-09-1300",
      ],
      paths,
      model,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(io.written).toHaveLength(0);
  });

  it("revises an existing description only after cooldown + 5 new slices", async () => {
    seededEntity("x", "2026-08-01");
    const oldRaw = io.files.get("memory/episodic/strands/x.md")!;

    // Within cooldown → refused, file untouched.
    ai.streamText.mockResolvedValue(descriptionToolCall("新描述。"));
    const blocked = await refreshStrandDescription({
      name: "x",
      sliceIds: [
        "2026-08-10-0900",
        "2026-08-11-0900",
        "2026-08-12-0900",
        "2026-08-13-0900",
        "2026-08-14-0900",
      ],
      paths: [
        "2026/08/01/0900",
        "2026/08/10/0900",
        "2026/08/11/0900",
        "2026/08/12/0900",
        "2026/08/13/0900",
        "2026/08/14/0900",
      ],
      model,
      nowMs: Date.UTC(2026, 7, 5, 12, 0), // 4 days after last_active
    });
    expect(blocked.ok).toBe(false);
    expect(io.files.get("memory/episodic/strands/x.md")).toBe(oldRaw);
    expect(ai.streamText).not.toHaveBeenCalled();


    // After cooldown → refreshed, and the model saw the existing description.
    const ok = await refreshStrandDescription({
      name: "x",
      sliceIds: [
        "2026-08-10-0900",
        "2026-08-11-0900",
        "2026-08-12-0900",
        "2026-08-13-0900",
        "2026-08-14-0900",
      ],
      paths: [
        "2026/08/01/0900",
        "2026/08/10/0900",
        "2026/08/11/0900",
        "2026/08/12/0900",
        "2026/08/13/0900",
        "2026/08/14/0900",
      ],
      model,
      nowMs: Date.UTC(2026, 7, 20, 12, 0), // 19 days after last_active
    });
    expect(ok.ok).toBe(true);
    const revised = io.files.get("memory/episodic/strands/x.md")!;
    expect(revised).toContain("新描述。");
    expect(revised).toContain("first_seen: '2026-08-01'");
    expect(revised).toContain("last_active: '2026-08-14'");
    // The revision prompt carried the old description as revision material.
    const promptArg = ai.streamText.mock.calls.at(-1)?.[0];
    expect(String(promptArg?.prompt)).toContain("旧描述。");
  });
});

describe("refreshStrandDescriptions (index sweep)", () => {
  it("refreshes only due strands and reports skips with reasons", async () => {
    ai.streamText.mockResolvedValue(descriptionToolCall("描述。"));
    const strands = {
      // Due: 5 slices, no entity yet.
      due: [
        "2026/08/01/0900",
        "2026/08/02/0900",
        "2026/08/03/0900",
        "2026/08/04/0900",
        "2026/08/05/0900",
      ],
      // Not due: only 2 slices.
      thin: ["2026/08/01/0900", "2026/08/02/0900"],
    };
    const result = await refreshStrandDescriptions(strands, model);
    expect(result.refreshed).toEqual(["due"]);
    expect(result.skipped).toEqual([
      { name: "thin", reason: expect.stringContaining("new slice") },
    ]);
    expect(io.files.has("memory/episodic/strands/due.md")).toBe(true);
    expect(io.files.has("memory/episodic/strands/thin.md")).toBe(false);
  });
});
