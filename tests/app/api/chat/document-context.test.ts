import { beforeEach, describe, expect, it, vi } from "vitest";

const workflow = vi.hoisted(() => ({ start: vi.fn(async () => ({})) }));
vi.mock("workflow/api", () => ({ start: workflow.start }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: vi.fn() }));

const loader = vi.hoisted(() => ({ loadUserConfig: vi.fn() }));
vi.mock("@/lib/config/loader", () => ({ loadUserConfig: loader.loadUserConfig }));
vi.mock("@/lib/models/catalog", () => ({ resolveAvailableModels: vi.fn(async () => []) }));
vi.mock("@/lib/capabilities", () => ({ getRepoConfig: () => ({ owner: "local", repo: "local" }) }));
const dataSource = vi.hoisted(() => ({ resolveDataSource: vi.fn(() => "local") }));
vi.mock("@/lib/data-source/resolve", () => ({ resolveDataSource: dataSource.resolveDataSource }));
vi.mock("@/lib/demo/model-lock", () => ({ demoModelLock: vi.fn(() => null) }));

import { startTurn } from "@/app/api/chat/start-turn";

describe("explicit document context at the route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dataSource.resolveDataSource.mockReturnValue("local");
    loader.loadUserConfig.mockResolvedValue({ model: { provider: "deepseek-flash" } });
  });

  it("drops malformed context without dropping or rewriting the user message", async () => {
    await startTurn({
      regenerate: true,
      messages: [{
        id: "user-original",
        role: "user",
        parts: [{ type: "text", text: "original user question" }],
      }],
      documentContext: {
        version: 1,
        references: [
          { ref: "research/项目", title: "项目", quote: "unverified" },
          { ref: "../outside", title: "bad" },
          { ref: "records/9999-99-99-9999" },
          { ref: "research/escaped%2Fname" },
          { ref: "research/too-long", quote: "x".repeat(1201) },
        ],
      },
    });
    const args = workflow.start.mock.calls.at(-1) as unknown as [unknown, [Record<string, unknown>]];
    const input = args[1][0];
    expect(input.lastUserMessage).toBe("original user question");
    expect(input.documentContext).toEqual([{ ref: "research/项目", title: "项目", quote: "unverified" }]);
    expect(input.regenerate).toBe(true);
    expect(input.screen).toBeUndefined();
    expect(JSON.stringify(input.modelMessages)).toContain("original user question");
    expect(JSON.stringify(input.modelMessages)).not.toContain("unverified");
  });

  it("keeps explicit references separate from passive screen observations", async () => {
    const screen = {
      capturedAt: "2026-10-27T12:00:00.000Z",
      current: { kind: "document", ref: "research/passive", page: 1, totalPages: 1, origin: "observed" },
      recent: [],
    };
    await startTurn({
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "question" }] }],
      screen,
      documentContext: [{ ref: "research/explicit" }],
    });
    const args = workflow.start.mock.calls.at(-1) as unknown as [unknown, [Record<string, unknown>]];
    const input = args[1][0];
    expect(input.screen).toEqual(screen);
    expect(input.documentContext).toEqual([{ ref: "research/explicit" }]);
    expect(input.lastUserMessage).toBe("question");
    expect(input.documentContext).not.toEqual(input.screen);
  });
});
