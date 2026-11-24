import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";

const mocks = vi.hoisted(() => ({ runSubAgent: vi.fn(), search: vi.fn(), image: vi.fn() }));
vi.mock("@/lib/agents/sub-agent-runner", () => ({ runSubAgent: mocks.runSubAgent }));
vi.mock("@/lib/search/deepseek-web", async (original) => ({
  ...await original<typeof import("@/lib/search/deepseek-web")>(),
  deepseekWebSearch: mocks.search,
}));
vi.mock("@/lib/vision/describe-image", () => ({ describeImage: mocks.image }));
import { searchViaFlash, type WebSearchResult } from "@/lib/search/flash-search";

type Options = RunSubAgentOptions<unknown>;
const report = { answer: "The answer.", recommendation: "Well supported.", suggested_reads: [] };
const success = { ok: true, report, text: "" };
function options(): Options { return mocks.runSubAgent.mock.calls[0]![0]; }
function execute(opts: Options, toolName: string, input: unknown, abortSignal?: AbortSignal) {
  return opts.tools[toolName]!.execute!(input, { toolCallId: "test", messages: [], context: {}, abortSignal });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runSubAgent.mockResolvedValue(success);
  mocks.search.mockResolvedValue({ results: [] });
  mocks.image.mockResolvedValue({ ok: true, description: "Image description" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("searchViaFlash", () => {
  it("uses the fixed search role and preserves the static/dynamic prompt split", async () => {
    await searchViaFlash("latest Next.js version");
    const opts = options();
    expect(opts.role).toBe("search");
    expect(opts).not.toHaveProperty("languageModel");
    expect(opts).not.toHaveProperty("effortSdk");
    expect(opts).not.toHaveProperty("providerOptions");
    expect(opts).not.toHaveProperty("maxSteps");
    expect(opts).not.toHaveProperty("timeoutMs");
    expect(opts.reportToolName).toBe("searchReport");
    expect(opts.selfSop).toBe("search");
    expect(opts.system).toContain("independent researcher");
    expect(opts.system).not.toContain("Today is");
    expect(opts.prompt).toMatch(/^Today is \d{4}-\d{2}-\d{2}\./);
    expect(opts.prompt).toContain("Query: latest Next.js version");
    expect(Object.keys(opts.tools).sort()).toEqual(["searchReport", "viewImage", "webFetch", "web_search"]);
  });

  it("accepts legacy four-field results while actual runs supply exact metadata", async () => {
    const legacy: WebSearchResult = {
      answer: "Outer timeout fallback.",
      sources: [],
      recommendation: "Request counts are unknown.",
      suggestedReads: [],
    };
    expect(legacy.searchStats).toBeUndefined();

    const out = await searchViaFlash("q");
    expect(out.searchStats).toEqual({
      operationsStarted: 0,
      operationsSucceeded: 0,
      duplicateHits: 0,
      inFlightHits: 0,
    });
  });

  it("maps the report and collects deduplicated sources only from actual search results", async () => {
    mocks.search.mockResolvedValue({ results: [
      { title: "A", url: "https://example.com/a", summary: "Evidence" },
      { title: "A", url: "https://example.com/a", summary: "Duplicate" },
    ] });
    mocks.runSubAgent.mockImplementation(async (opts: Options) => {
      await execute(opts, "web_search", { query: "evidence", count: 3 });
      return { ...success, report: { ...report, suggested_reads: [
        { url: "https://example.com/a", title: "A", reason: "primary" },
        { url: "", title: "bad", reason: "no URL" },
      ] }, sources: [{ sourceType: "url", title: "Invented", url: "https://invented.example" }] };
    });
    const out = await searchViaFlash("q");
    expect(out.answer).toBe(report.answer);
    expect(out.recommendation).toBe(report.recommendation);
    expect(out.suggestedReads).toEqual([{ url: "https://example.com/a", title: "A", reason: "primary" }]);
    expect(out.sources).toEqual([{ title: "A", url: "https://example.com/a", read: false }]);
    expect(mocks.search).toHaveBeenCalledWith(
      { query: "evidence", count: 3 },
      undefined,
    );
  });

  it.each([false, true])("allows either research mode to follow new leads without a fixed operation budget", async (scout) => {
    await searchViaFlash("q", undefined, { scout });
    const opts = options();
    const controller = new AbortController();
    for (let i = 0; i < 33; i++) await execute(opts, "web_search", { query: `lead ${i}` }, controller.signal);
    expect(mocks.search).toHaveBeenCalledTimes(33);
    expect(mocks.search.mock.lastCall?.[1]).toBe(controller.signal);
    expect(opts).not.toHaveProperty("prepareStep");
  });

  it("keeps operation budgets and successful-query dedup independent for each run", async () => {
    await searchViaFlash("q", undefined, { scout: true });
    const first = options();
    for (let i = 0; i < 4; i++) await execute(first, "web_search", { query: `q${i}` });
    await execute(first, "web_search", { query: "q0" });
    expect(mocks.search).toHaveBeenCalledTimes(4);

    await searchViaFlash("another query", undefined, { scout: true });
    await execute(mocks.runSubAgent.mock.calls[1]![0], "web_search", { query: "q0" });
    expect(mocks.search).toHaveBeenCalledTimes(5);
  });

  it.each(["http://localhost/a", "http://169.254.169.254", "file:///etc/passwd"])("rejects unsafe page URL %s", async (url) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await searchViaFlash("q");
    expect(await execute(options(), "webFetch", { url })).toMatch(/ERROR: (Cannot fetch|Unsupported URL)/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can examine further images while investigation calls for them", async () => {
    await searchViaFlash("q");
    for (let i = 0; i < 3; i++) expect(await execute(options(), "viewImage", { url: `https://example.com/${i}.png` })).toBe("Image description");
    expect(mocks.image).toHaveBeenCalledTimes(3);
  });

  it("reports progress without contacting the search provider", async () => {
    await searchViaFlash("q");
    expect(options().onToolProgress!({ toolName: "web_search", input: {} })?.line).toContain("Searching");
    expect(options().onToolProgress!({ toolName: "webFetch", input: {} })?.line).toContain("Reading");
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("recovers an unfiled report as explicitly lower-confidence final text", async () => {
    mocks.runSubAgent.mockResolvedValue({ ok: true, text: "Partial findings" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await searchViaFlash("q");
    expect(out.answer).toBe("Partial findings");
    expect(out.recommendation).toContain("without filing a structured report");
    expect(out.sources).toEqual([]);
  });

  it("preserves observed sources when a timed-out run has partial text", async () => {
    mocks.search.mockResolvedValue({ results: [{ title: "Docs", url: "https://example.com/docs" }] });
    mocks.runSubAgent.mockImplementation(async (opts: Options) => {
      await execute(opts, "web_search", { query: "q" });
      return { ok: false, timedOut: true, text: "Partial findings", error: "Deadline" };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await searchViaFlash("q");
    expect(out.answer).toBe("Partial findings");
    expect(out.recommendation).toContain("partial, unverified");
    expect(out.sources).toEqual([{ title: "Docs", url: "https://example.com/docs", read: false }]);
  });

  it("throws failed or empty timed-out runs for outer error classification", async () => {
    mocks.runSubAgent.mockResolvedValue({ ok: false, text: "", error: "HTTP 429" });
    await expect(searchViaFlash("q")).rejects.toThrow("HTTP 429");
    mocks.runSubAgent.mockResolvedValue({ ok: false, timedOut: true, text: "", error: "Deadline" });
    await expect(searchViaFlash("q")).rejects.toThrow("Deadline");
  });
});
