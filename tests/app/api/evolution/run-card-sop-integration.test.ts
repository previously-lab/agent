import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { newCardTemplate } from "@/lib/episodic/previously-format";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";
import type {
  RunCardEvolutionInput,
  RunCardEvolutionResult,
} from "@/app/api/evolution/run-card-evolution";
import type { ModelConfig } from "@/lib/models/registry";

const runner = vi.hoisted(() => ({ runSubAgent: vi.fn() }));
vi.mock("@/lib/agents/sub-agent-runner", () => runner);
vi.mock("@/lib/episodic", () => ({ writePreviously: vi.fn() }));
vi.mock("@/lib/episodic/timeline/enumerate", () => ({
  enumerateSliceIds: vi.fn(async (): Promise<string[]> => []),
}));

const SLICE = "2026-08-17-0515";
const BASE = newCardTemplate(SLICE);
const MODEL = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
} satisfies ModelConfig;

type RunnerOptions = RunSubAgentOptions<unknown>;
let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;
let origMemoryRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-sop-integration-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  origMemoryRoot = process.env.MEMORY_ROOT;
  process.env.STORAGE = "local";
  process.env.MEMORY_ROOT = path.join(tmpDir, "memory");
  process.chdir(tmpDir);
  vi.resetModules();
  runner.runSubAgent.mockReset();
  writeOnDisk("memory/people/user/index.md", BASE);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) process.env.STORAGE = origStorage;
  else delete process.env.STORAGE;
  if (origMemoryRoot !== undefined) process.env.MEMORY_ROOT = origMemoryRoot;
  else delete process.env.MEMORY_ROOT;
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeOnDisk(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function readOnDisk(relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
  } catch {
    return null;
  }
}

async function callTool(
  options: RunnerOptions,
  name: string,
  args: unknown,
): Promise<string> {
  const tool = options.tools[name] as unknown as {
    execute: (args: unknown, context: unknown) => Promise<string>;
  };
  return tool.execute(args, { toolCallId: "integration", messages: [] });
}

async function runEvolution(): Promise<RunCardEvolutionResult> {
  const { runCardEvolution } = await import("@/app/api/evolution/run-card-evolution");
  const input: RunCardEvolutionInput = {
    model: MODEL,
    sliceId: SLICE,
    recentTurns: [{ role: "user", content: "Quote the record before answering." }],
    allowedSopWrites: ["search"],
    readers: {
      readSlice: async () => "record",
      readAgentTimeline: async () => "timeline",
      readPreviously: async () => BASE,
    },
  };
  return runCardEvolution(input);
}

describe("Previously to run-card SOP integration", () => {
  it("passes the full old SOP through the real worker and applies its revision-guarded write", async () => {
    const oldSop = `# Legacy search SOP\n\n${"keep this unrelated whole rule\n".repeat(100)}`;
    const newSop = `${oldSop}\n2026-08-17: cite 2026-08-17-0515 before quoting a record.`;
    writeOnDisk("memory/agent-playbooks/search.md", oldSop);
    runner.runSubAgent.mockImplementation(async (options: RunnerOptions) => {
      expect(options.prompt).toContain(oldSop);
      expect(options.prompt).toContain("effective origin: legacy");
      expect(options.prompt).toContain("new_observation — a new round of conversation happened");
      const staged = await callTool(options, "writeSop", {
        agent: "search",
        content: newSop,
        evidence: ["2026-08-17-0515"],
        expectedBenefit: "Citations remain grounded",
        applicability: "When answering from an earlier record",
      });
      expect(staged).toContain("staged from the recorded read");
      return { ok: true, report: { reasoning: "done", summary: "" }, text: "" };
    });

    const result = await runEvolution();
    expect(result.playbooks).toEqual([{
      agent: "search",
      summary: "Citations remain grounded",
    }]);
    expect(result.playbookRejections).toBeUndefined();
    expect(readOnDisk("memory/self/search/index.md")).toBe(newSop);
    expect(readOnDisk("memory/agent-playbooks/search.md")).toBe(oldSop);
  });

  it("preserves a concurrent new-root rule and reports the staged write as stale", async () => {
    const oldSop = "Original legacy rule.";
    writeOnDisk("memory/agent-playbooks/search.md", oldSop);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runner.runSubAgent.mockImplementation(async (options: RunnerOptions) => {
      expect(options.prompt).toContain(oldSop);
      writeOnDisk("memory/self/search/index.md", "Concurrent rule that must survive.");
      await callTool(options, "writeSop", {
        agent: "search",
        content: "Stale replacement.",
        evidence: ["2026-08-17-0515"],
        expectedBenefit: "Unverified expected benefit",
        applicability: "When searching",
      });
      return { ok: true, report: { reasoning: "done", summary: "" }, text: "" };
    });

    const result = await runEvolution();
    expect(result.playbooks).toBeUndefined();
    expect(result.playbookRejections).toHaveLength(1);
    expect(result.playbookRejections?.[0].summary).toContain("SOP changed after the recorded");
    expect(readOnDisk("memory/self/search/index.md")).toBe("Concurrent rule that must survive.");
    expect(readOnDisk("memory/agent-playbooks/search.md")).toBe(oldSop);
    warn.mockRestore();
  });
});
