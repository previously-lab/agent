import { describe, it, expect, beforeEach, vi } from "vitest";

// Route-level test with the I/O seams mocked, mirroring
// tests/app/api/chat/chat.test.ts and tests/app/api/episodic-flush.test.ts:
// we cover the route's own responsibility (guard + validation + budget +
// model-resolution gating + prompt layering), not the storage backends or
// the LLM call (streamText is mocked; the tools are exercised separately in
// companion-tools.test.ts).

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    createModel: vi.fn(),
    streamText: vi.fn(),
  };
});

vi.mock("ai", () => ({
  streamText: hoisted.streamText,
  // tool() passthrough — companion-tools.test.ts exercises the real shape.
  tool: (def: unknown) => def,
  isStepCount: (n: number) => ({ kind: "step-count", n }),
}));

vi.mock("@/lib/models/provider", () => ({
  createModel: hoisted.createModel,
}));

vi.mock("@/lib/config/loader", () => ({
  loadUserConfig: vi.fn(async () => ({
    model: { provider: "deepseek-flash" },
  })),
}));

// Memory reads ride an in-memory Map on the local backend (STORAGE=local is
// stubbed in beforeEach). GitHub/demo reads must never fire in these tests.
vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (p: string) => {
    const v = hoisted.files.get(p);
    if (v === undefined) throw new Error(`File not found: "${p}"`);
    return v;
  },
  listFilesLocal: vi.fn(async () => []),
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  invalidateReadCache: vi.fn(),
}));
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: vi.fn(async () => {
    throw new Error("demo read should not be called in local mode");
  }),
  listFilesDemo: vi.fn(async () => []),
}));

import { POST } from "@/app/api/companion/route";
import { resetCompanionBudget } from "@/app/api/companion/budget";
import { DEFAULT_COMPANION_PLAYBOOK } from "@/app/api/companion/default-playbook";

function companionReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/companion", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { sliceId: "2026-07-28-0658", event: "narrate", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("STORAGE", "local");
  hoisted.files.clear();
  resetCompanionBudget();
  hoisted.createModel.mockReturnValue({ __model: true });
  hoisted.streamText.mockReturnValue({
    toTextStreamResponse: () =>
      new Response("narration-text", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
  });
});

describe("POST /api/companion validation", () => {
  it("rejects a non-slice-id string", async () => {
    const res = await POST(companionReq(validBody({ sliceId: "not-a-slice" })));
    expect(res.status).toBe(400);
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });

  it("rejects path-traversal sliceIds", async () => {
    const res = await POST(companionReq(validBody({ sliceId: "../../../../etc/passwd" })));
    expect(res.status).toBe(400);
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });

  it("rejects date-only ids (strict YYYY-MM-DD-HHMM required)", async () => {
    const res = await POST(companionReq(validBody({ sliceId: "2026-07-28" })));
    expect(res.status).toBe(400);
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });

  it("rejects an unknown event", async () => {
    const res = await POST(companionReq(validBody({ event: "summarize" })));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeTruthy();
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });

  it("rejects an invalid JSON body", async () => {
    const res = await POST(companionReq("not json"));
    expect(res.status).toBe(400);
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });

  it("validates the sliceId before any memory read", async () => {
    const res = await POST(companionReq(validBody({ sliceId: "bad-id" })));
    expect(res.status).toBe(400);
    expect(hoisted.files.size).toBe(0);
  });
});

describe("POST /api/companion origin guard", () => {
  it("returns 403 for cross-site posts when ACCESS_SECRET is set", async () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    const res = await POST(
      companionReq(validBody(), { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });

  it("allows requests carrying the access key", async () => {
    vi.stubEnv("ACCESS_SECRET", "s3cret");
    const res = await POST(
      companionReq(validBody(), { "x-access-key": "s3cret" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/companion narration", () => {
  it("streams text/plain on success and instantiates the resolved model plainly", async () => {
    const res = await POST(companionReq(validBody({ timezone: "Asia/Shanghai" })));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("narration-text");

    // createModel receives the resolved curated config directly (no
    // StepBoundaryLanguageModel wrapper — plain instantiation).
    expect(hoisted.createModel).toHaveBeenCalledTimes(1);
    const cfg = hoisted.createModel.mock.calls[0][0] as { id: string; sdk: string };
    expect(cfg.id).toBe("deepseek-flash");
  });

  it("layers the prompt stable-first with the event context last", async () => {
    await POST(companionReq(validBody({ locale: "zh" })));
    const call = hoisted.streamText.mock.calls.at(-1)?.[0] as {
      system: string;
      prompt: string;
    };
    const identityAt = call.system.indexOf("You are Previously"); // L0 charter
    const playbookAt = call.system.indexOf("## Companion playbook");
    const eventAt = call.system.indexOf("## Event context");
    expect(identityAt).toBeGreaterThanOrEqual(0);
    expect(playbookAt).toBeGreaterThan(identityAt);
    expect(eventAt).toBeGreaterThan(playbookAt);
    // L3 carries the target slice and the local clock.
    expect(call.system).toContain("2026-07-28-0658");
    expect(call.prompt).toContain("Chinese");
  });

  it("falls back to the built-in default playbook when companion.md is unreadable", async () => {
    hoisted.files.set("memory/episodic/current-previously.md", "## Identity\n\n- 自称 Dream\n");
    await POST(companionReq(validBody()));
    const call = hoisted.streamText.mock.calls.at(-1)?.[0] as { system: string };
    expect(call.system).toContain("## Companion playbook");
    expect(call.system).toContain(DEFAULT_COMPANION_PLAYBOOK);
    expect(call.system).not.toContain("EVOLVED_COMPANION_MARKDOWN");
  });

  it("uses the live companion playbook when it reads", async () => {
    hoisted.files.set(
      "memory/agent-playbooks/companion.md",
      "EVOLVED_COMPANION_MARKDOWN — always narrate in verse",
    );
    await POST(companionReq(validBody()));
    const call = hoisted.streamText.mock.calls.at(-1)?.[0] as { system: string };
    expect(call.system).toContain("EVOLVED_COMPANION_MARKDOWN");
    expect(call.system).not.toContain("旁白默认手册");
  });

  it("defaults the locale to en and follows an explicit zh", async () => {
    await POST(companionReq(validBody()));
    expect(
      (hoisted.streamText.mock.calls.at(-1)?.[0] as { prompt: string }).prompt,
    ).toContain("English");

    await POST(companionReq(validBody({ locale: "zh" })));
    expect(
      (hoisted.streamText.mock.calls.at(-1)?.[0] as { prompt: string }).prompt,
    ).toContain("Chinese");
  });
});

describe("POST /api/companion model resolution", () => {
  it("returns 501 when the resolved model is the bridge brain", async () => {
    vi.stubEnv("PREVIOUSLY_MODE", "client");
    vi.stubEnv("PREVIOUSLY_BRAIN", "bridge");
    const { loadUserConfig } = await import("@/lib/config/loader");
    vi.mocked(loadUserConfig).mockResolvedValueOnce({
      model: { provider: "bridge/claude" },
    } as never);
    const res = await POST(companionReq(validBody()));
    expect(res.status).toBe(501);
    const data = await res.json();
    expect(data.error).toBeTruthy();
    expect(hoisted.streamText).not.toHaveBeenCalled();
  });
});

describe("POST /api/companion budget gate", () => {
  it("allows 20 narrations and rejects the 21st with 429", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await POST(companionReq(validBody()));
      expect(res.status).toBe(200);
    }
    const res = await POST(companionReq(validBody()));
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe("budget_exhausted");
    // Budget was already exhausted: the model is never touched.
    expect(hoisted.streamText).toHaveBeenCalledTimes(20);
  });

  it("keys the budget by the first x-forwarded-for entry", async () => {
    const one = await POST(
      companionReq(validBody(), { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }),
    );
    const two = await POST(
      companionReq(validBody(), { "x-forwarded-for": "2.2.2.2" }),
    );
    // Different first entries → different buckets → both allowed.
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
  });
});
