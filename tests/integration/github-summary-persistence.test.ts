import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createNextDataCacheContext } from "../helpers/next-data-cache-context";
import { createGitHubRecordRepository } from "../helpers/github-record-repository";
import type { SummaryRunPayload } from "@/lib/chat/turn-types";

const fixture = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/github/client", async (original) => ({ ...(await original<typeof import("@/lib/github/client")>()), getOctokit: () => fixture.client }));
vi.mock("workflow", () => ({ getWorkflowMetadata: () => ({ workflowRunId: "summary-http-fixture" }), getWritable: () => ({ getWriter: () => ({ write: async () => {}, releaseLock() {} }) }), setAttributes: async () => {} }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: async () => ({ data: [] }) } }) }));
vi.mock("workflow/api", () => ({ getRun: vi.fn(), resumeHook: vi.fn(), start: vi.fn() }));
vi.mock("@/app/api/evolution/reflection-wake", () => ({ deliverReflectionWake: async () => ({ ok: true, delivered: "rung", runId: "reflection" }) }));
vi.mock("@/lib/episodic/flash/turn-analyzer", () => ({ analyzeTurn: async () => null }));
const env = { STORAGE: process.env.STORAGE, GITHUB_REPO_OWNER: process.env.GITHUB_REPO_OWNER, GITHUB_REPO_NAME: process.env.GITHUB_REPO_NAME };
beforeAll(() => { createNextDataCacheContext(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe("GitHub summary writes with real transport and ref conflicts", () => {
  it("reassembles from the new HEAD after a concurrent writer, then dedupes replay", async () => {
    process.env.STORAGE = "github"; process.env.GITHUB_REPO_OWNER = "fixture"; process.env.GITHUB_REPO_NAME = "records";
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const file = "memory/records/2026/10/22/0800/core.md";
    const original = "---\nslice_id: 2026-10-22-0800\nstart: 2026-10-22T08:00:00Z\n---\n\n## Turn older1 \u2014 2026-10-22T08:00:00Z (user)\n\nOld question\n";
    const remote = original + "\n## Turn other1 \u2014 2026-10-22T08:01:00Z (user)\n\nConcurrent question\n\n## Turn other1 \u2014 2026-10-22T08:01:00Z (agent)\n\nConcurrent answer\n";
    const repository = createGitHubRecordRepository({ [file]: original });
    const { createOctokitForTest } = await import("@/lib/github/client");
    fixture.client = createOctokitForTest(repository.fetch);
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const payload: SummaryRunPayload = { sliceId: "2026-10-22-0800", burstId: "burst", date: "2026-10-22", own: { turnId: "mine1", clientMessageId: "client-mine", sliceId: "2026-10-22-0800", at: "2026-10-22T08:02:00Z", userText: "My question", replyText: "My answer", cognition: "" }, slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 40 }, clientTimezone: "UTC", modelConfig: { id: "fixture", sdk: "deepseek" } as SummaryRunPayload["modelConfig"], useGithub: true, useDemo: false, owner: "fixture", repo: "records", locale: "en" };
    repository.interfereNextRef({ [file]: remote });
    const context = createNextDataCacheContext();
    await context.run(async () => {
      const result = await persistTurnSummary(payload);
      await context.flush();
      expect(result.kind).toBe("committed");
      expect(result.receipt?.commitSha).toBe(repository.head);
      const replay = await persistTurnSummary(payload);
      expect(replay.kind).toBe("deduped");
      expect(replay.receipt?.commitSha).toBe(repository.head);
    });
    expect(repository.conflicts).toBe(1);
    const raw = repository.files()[file]!;
    expect(raw).toContain("Concurrent answer");
    expect(raw.match(/My question/g)).toHaveLength(1);
    expect(raw.match(/My answer/g)).toHaveLength(1);
    expect(repository.requests.filter((r) => r.path.startsWith("/commits"))).toHaveLength(0);
  }, 60_000);
});
