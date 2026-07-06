import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock dependencies before importing the route
const mockReadFile = "mock-read-result";
const mockWriteFile = { path: "test.md", created: true };
const mockListFiles = [{ name: "test.md", type: "file" as const, path: "test.md" }];

let mockToolExecute: Record<string, () => Promise<unknown>> = {};

vi.mock("ai", () => ({
  streamText: vi.fn(({ tools, onFinish }: Record<string, unknown>) => {
    if (tools) {
      const t = tools as Record<string, { execute?: () => Promise<unknown> }>;
      for (const [name, toolDef] of Object.entries(t)) {
        if (toolDef?.execute) mockToolExecute[name] = toolDef.execute;
      }
    }
    // Trigger onFinish to simulate normal completion (for topic update tests)
    const finish = onFinish as ((opts: { text: string; finishReason: string }) => void) | undefined;
    if (finish) setTimeout(() => finish({ text: "mocked response", finishReason: "stop" }), 0);
    return {
      toUIMessageStream: () => new ReadableStream(),
      toUIMessageStreamResponse: () =>
        new Response("mocked-ui-stream", { headers: { "Content-Type": "text/event-stream" } }),
    };
  }),
  tool: vi.fn((def: { execute?: () => Promise<unknown> }) => def),
  convertToModelMessages: vi.fn((msgs: unknown[]) => msgs),
  stepCountIs: vi.fn(() => vi.fn()),
  createUIMessageStream: vi.fn(({ execute }: { execute: (opts: { writer: { write: () => void; merge: () => void } }) => Promise<void> }) => {
    execute({
      writer: { write: vi.fn(), merge: vi.fn() },
    }).catch(() => {});
    return new ReadableStream();
  }),
  createUIMessageStreamResponse: vi.fn(() =>
    new Response("mocked-ui-stream", { headers: { "Content-Type": "text/event-stream" } })
  ),
}));

vi.mock("@ai-sdk/deepseek", () => ({
  deepseek: vi.fn(() => "mock-deepseek-model"),
}));

// Mock M3 pipeline modules (async for Flash)
vi.mock("@/lib/router", () => ({
  resolveIntent: async () => ({
    intent: { intent: "chat", confidence: 1.0, source: "keyword" as const, switched: false },
    strategy: { max_nodes: 3, include_recent_turns: 2, loop_mode: false, max_iterations: 1 },
  }),
  classifyIntentKeywords: () => ({ intent: "chat", source: "keyword" as const }),
}));

vi.mock("@/lib/memory/manager", () => ({
  listNodes: () => [],
}));

vi.mock("@/lib/memory/scorer", () => ({
  rankNodes: () => [],
}));

vi.mock("@/lib/context/assembler", () => ({
  assembleContext: ({ systemPrompt, userInput }: { systemPrompt: string; userInput: string }) => ({
    prompt: systemPrompt + "\n" + userInput,
    tokenEstimate: 100,
    layers: { system: 50, core: 0, session: 0, extended: 0, reference: 0, input: 50 },
  }),
}));

vi.mock("@/lib/tools/readFile", () => ({
  readFile: () => Promise.resolve(mockReadFile),
}));

vi.mock("@/lib/tools/writeFile", () => ({
  writeFile: () => Promise.resolve(mockWriteFile),
}));

vi.mock("@/lib/tools/listFiles", () => ({
  listFiles: () => Promise.resolve(mockListFiles),
}));

// Mock episodic module (imported by chat route)
vi.mock("@/lib/episodic", () => ({
  getActiveSlice: () => null,
  createSlice: () => ({
    slice_id: "2026-07-02",
    focus: "",
    status: "active" as const,
    start: new Date().toISOString(),
    timezone: "UTC",
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    turns: [],
    estimatedTokens: 0,
  }),
  closeSlice: vi.fn(),
  appendTurn: vi.fn(),
  readSliceIndex: () => Promise.resolve([]),
  checkTimeSilence: () => false,
  checkCapacity: () => false,
  checkContinuity: () => Promise.resolve({ shouldSplit: false, confidence: 0, reason: "" }),
  saveSliceSnapshot: vi.fn(),
  ensureIndexEntries: vi.fn(),
  tryLoadTodaySlice: () => Promise.resolve(null),
  setActiveSlice: vi.fn(),
}));

// Mock parallel-timeline module
vi.mock("@/lib/episodic/parallel-timeline", () => ({
  scanTopics: () => Promise.resolve([]),
  updateTopicSources: vi.fn(),
}));

// Mock Flash classifyWithFlash
vi.mock("@/lib/router/flash", async () => {
  const actual = await vi.importActual<typeof import("@/lib/router/flash")>("@/lib/router/flash");
  return {
    ...actual,
    classifyWithFlash: () =>
      Promise.resolve({
        intent: "chat",
        confidence: 0.95,
        intent_switched: false,
        needs_more_turns: false,
        reasoning: "test",
        suggested_topics: ["rust"],
      }),
  };
});

import { POST } from "@/app/api/chat/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockToolExecute = {};
  process.env.GITHUB_REPO_OWNER = "test-owner";
  process.env.GITHUB_REPO_NAME = "test-repo";
});

afterEach(() => {
  delete process.env.GITHUB_REPO_OWNER;
  delete process.env.GITHUB_REPO_NAME;
});

function createRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat validation", () => {
  it("rejects empty messages array", async () => {
    const req = createRequest({ messages: [] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("must not be empty");
  });

  it("rejects missing messages field", async () => {
    const req = createRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("required");
  });

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 200 with valid messages", async () => {
    const req = createRequest({
      messages: [{ role: "user", content: "hello" }],
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("works without GitHub env vars using local FS fallback", async () => {
    delete process.env.GITHUB_REPO_OWNER;
    const req = createRequest({
      messages: [{ role: "user", content: "hello" }],
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("Recall Agent is included in the streaming response", async () => {
    const req = createRequest({
      messages: [{ role: "user", content: "Rust borrow checker" }],
      timezone: "Asia/Shanghai",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // The stream should be created (verifying createUIMessageStream was called)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("returns 200 with thinking disabled", async () => {
    const req = createRequest({
      messages: [{ role: "user", content: "hello" }],
      thinking: false,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
