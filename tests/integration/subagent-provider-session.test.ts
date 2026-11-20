import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { recallScenarioExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { handleReflectionRound, type ReflectionDocket } from "@/app/api/evolution/reflection-steps";
import { requestDeepSeek } from "@/lib/deepseek/http";

vi.mock("workflow", async importOriginal => ({
  ...await importOriginal<typeof import("workflow")>(),
  getWorkflowMetadata: () => ({ workflowRunId: "wrun_reflection" }),
}));
vi.mock("@/lib/deepseek/http", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/deepseek/http")>();
  return { ...original, requestDeepSeek: vi.fn(original.requestDeepSeek) };
});

const host = "https://fixture.invalid/v1";
const key = "compatible-only-fixture-key";
const sourceSlice = "2026-11-08-1000";
const targetSlice = "2026-10-01-0800";
const context: ToolContext = {
  owner: "local", repo: "local", useDemo: false, useGithub: false, sliceId: sourceSlice,
  turnId: "owner-turn", readScopeId: "owner-scope", currentUserText: "", recentTurns: [],
};
const docket: ReflectionDocket = {
  date: "2026-11-08", cursor: null, scope: [{ sliceId: sourceSlice, turnIds: ["a"] }],
  nowIso: "2026-11-08T10:00:00Z", agendaWakeMs: null,
  evolutionDue: false, evolutionReasons: [], agendaDue: [], skillReviewDue: [],
};
let root: string;
let requests: Request[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagent-provider-session-"));
  vi.stubEnv("MEMORY_ROOT", root);
  vi.stubEnv("TASKS_ROOT", join(root, "tasks"));
  vi.stubEnv("SESSIONS_ROOT", join(root, "sessions"));
  vi.stubEnv("PREVIOUSLY_HOME", join(root, "home"));
  vi.stubEnv("STORAGE", "local");
  vi.stubEnv("PREVIOUSLY_MODE", "cloud");
  vi.stubEnv("CHAT_API_HOST", host);
  vi.stubEnv("CHAT_API_KEY", key);
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.mocked(requestDeepSeek).mockClear();
  requests = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(url, init);
    if (req.url !== host + "/chat/completions") throw new Error("Unexpected fixture URL");
    requests.push(req);
    const { tools } = await req.json() as { tools: Array<{ function: { name: string } }> };
    const name = tools.find(t => ["scenarioRecallReport", "hqReport"].includes(t.function.name))?.function.name;
    if (!name) throw new Error("Expected a sub-agent report");
    const args = name === "hqReport" ? { actions: [], note: "Fixture round." }
      : { answer: "", evidence: [], uncertainty: ["No original evidence."] };
    const call = { index: 0, id: "fixture-report", type: "function", function: { name, arguments: JSON.stringify(args) } };
    const frame = { choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (dirname(root) === tmpdir() && basename(root).startsWith("subagent-provider-session-")) {
    rmSync(root, { recursive: true, force: true });
  }
});

function expectSessions(ids: string[]) {
  expect(requests.map(req => req.headers.get("x-opencode-session"))).toEqual(ids);
  expect(requests.map(req => req.headers.get("authorization"))).toEqual(ids.map(() => `Bearer ${key}`));
  const modelRequests = vi.mocked(requestDeepSeek).mock.calls.map(([request]) => request);
  expect(modelRequests.map(request => request.sessionId)).toEqual(ids);
  expect(JSON.stringify(modelRequests)).not.toContain(key);
}

it("recallScenario keeps the owning conversation session across tool invocations", async () => {
  const input = { question: "Which detail was recorded?", refs: [`records/${targetSlice}`] };
  for (const toolCallId of ["first-lookup", "second-lookup"]) {
    await recallScenarioExecute(input, { context, toolCallId });
  }
  expectSessions([sourceSlice, sourceSlice]);
});

it("HQ uses the single source slice or the owning workflow for a multi-slice round", async () => {
  await handleReflectionRound(docket);
  const combined = { ...docket, scope: [...docket.scope, { sliceId: targetSlice, turnIds: ["b"] }] };
  await handleReflectionRound(combined);
  await handleReflectionRound({ ...docket, scope: [] });
  expectSessions([sourceSlice, "wrun_reflection", "wrun_reflection"]);
});
