import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock dependencies before importing the route
const mockReadFile = "mock-read-result";
const mockWriteFile = { path: "test.md", created: true };
const mockListFiles = [{ name: "test.md", type: "file" as const, path: "test.md" }];

let mockToolExecute: Record<string, () => Promise<unknown>> = {};

vi.mock("ai", () => ({
  streamText: vi.fn(({ tools }: { tools: Record<string, { execute?: () => Promise<unknown> }> }) => {
    for (const [name, t] of Object.entries(tools)) {
      if (t.execute) mockToolExecute[name] = t.execute;
    }
    return {
      toUIMessageStreamResponse: () =>
        new Response("mocked-ui-stream", { headers: { "Content-Type": "text/event-stream" } }),
    };
  }),
  tool: vi.fn((def: { execute?: () => Promise<unknown> }) => def),
  convertToModelMessages: vi.fn((msgs: unknown[]) => msgs),
  stepCountIs: vi.fn(() => vi.fn()),
}));

vi.mock("@ai-sdk/deepseek", () => ({
  deepseek: vi.fn(() => "mock-deepseek-model"),
}));

// Mock M3 pipeline modules
vi.mock("@/lib/router", () => ({
  resolveIntent: () => ({
    intent: { intent: "chat", confidence: 1.0, source: "keyword" as const, switched: false },
    strategy: { max_nodes: 3, include_recent_turns: 2, loop_mode: false, max_iterations: 1 },
  }),
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
});
