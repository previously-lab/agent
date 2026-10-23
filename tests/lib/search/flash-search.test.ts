import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";

const mocks = vi.hoisted(() => ({ runSubAgent: vi.fn(), search: vi.fn(), image: vi.fn() }));
vi.mock("@/lib/agents/sub-agent-runner", () => ({ runSubAgent: mocks.runSubAgent }));
vi.mock("@/lib/search/deepseek-web", async (original) => ({
  ...await original<typeof import("@/lib/search/deepseek-web")>(),
  deepseekWebSearch: mocks.search,
}));
vi.mock("@/lib/vision/describe-image", () => ({ describeImage: mocks.image }));
import { searchViaFlash } from "@/lib/search/flash-search";

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
    expect(opts.maxSteps).toBe(200);
    expect(opts).not.toHaveProperty("timeoutMs");
    expect(opts.reportToolName).toBe("searchReport");
    expect(opts.selfSop).toBe("search");
    expect(opts.system).toContain("independent researcher");
    expect(opts.system).not.toContain("Today is");
    expect(opts.prompt).toMatch(/^Today is \d{4}-\d{2}-\d{2}\./);
    expect(opts.prompt).toContain("Query: latest Next.js version");
    expect(Object.keys(opts.tools).sort()).toEqual(["searchReport", "viewImage", "webFetch", "web_search"]);
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
    expect(out.sources).toEqual([{ title: "A", url: "https://example.com/a" }]);
    expect(mocks.search).toHaveBeenCalledWith({ query: "evidence", count: 3 }, undefined);
  });

  it.each([[false, 50, 6], [true, 20, 3]])("enforces search and page quotas (scout=%s)", async (scout, rounds, pages) => {
    await searchViaFlash("q", undefined, { scout });
    const opts = options();
    expect(opts.system).toContain(`up to ${rounds} search rounds`);
    expect(opts.system).toContain(`read at most ${pages} pages per run`);
    for (let i = 0; i < rounds; i++) await execute(opts, "web_search", { query: "q" });
    expect(await execute(opts, "web_search", { query: "over quota" })).toEqual({
      results: [], note: "Search quota exhausted. Report what you have already found.",
    });
    expect(mocks.search).toHaveBeenCalledTimes(rounds);
    for (let i = 0; i < pages; i++) {
      expect(await execute(opts, "webFetch", { url: "not a url" })).toContain("ERROR: Invalid URL");
    }
    expect(await execute(opts, "webFetch", { url: "https://example.com" })).toContain("Page-read quota exhausted");
    expect(opts.prompt.includes("one of several researchers working in parallel")).toBe(scout);
  });

  it("counts failed searches against the quota and propagates cancellation to HTTP", async () => {
    await searchViaFlash("q", undefined, { scout: true });
    const opts = options();
    const controller = new AbortController();
    mocks.search.mockRejectedValue(new Error("HTTP 429"));
    for (let i = 0; i < 20; i++) {
      await expect(execute(opts, "web_search", { query: "q" }, controller.signal)).rejects.toThrow("HTTP 429");
    }
    expect(mocks.search).toHaveBeenCalledWith({ query: "q" }, controller.signal);
    expect(await execute(opts, "web_search", { query: "q" })).toHaveProperty("note");
    expect(mocks.search).toHaveBeenCalledTimes(20);
  });

  it("keeps search quota independent for each run", async () => {
    await searchViaFlash("q", undefined, { scout: true });
    const first = options();
    for (let i = 0; i < 20; i++) await execute(first, "web_search", { query: "q" });
    await searchViaFlash("another query", undefined, { scout: true });
    await execute(mocks.runSubAgent.mock.calls[1]![0], "web_search", { query: "q" });
    expect(mocks.search).toHaveBeenCalledTimes(21);
  });

  it.each(["http://localhost/a", "http://169.254.169.254", "file:///etc/passwd"])("rejects unsafe page URL %s", async (url) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await searchViaFlash("q");
    expect(await execute(options(), "webFetch", { url })).toMatch(/ERROR: (Cannot fetch|Unsupported URL)/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains redirect validation for page reads", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    vi.stubGlobal("fetch", fetch);
    await searchViaFlash("q");
    expect(await execute(options(), "webFetch", { url: "https://example.com" })).toContain("private network");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains selective page reads and the plain-text size cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("first line\nsecond line\n" + "x".repeat(16000))));
    await searchViaFlash("q");
    const opts = options();
    expect(await execute(opts, "webFetch", { url: "https://example.com", range: { type: "lines", start: 1, end: 2 } })).toContain("first line\nsecond line");
    expect(await execute(opts, "webFetch", { url: "https://example.com" })).toContain("Truncated at 15000 characters");
  });

  it("keeps the image quota separate and bounded", async () => {
    await searchViaFlash("q");
    const opts = options();
    for (let i = 0; i < 2; i++) expect(await execute(opts, "viewImage", { url: "https://example.com/a.png" })).toBe("Image description");
    expect(await execute(opts, "viewImage", { url: "https://example.com/b.png" })).toContain("Image-read quota exhausted");
    expect(mocks.image).toHaveBeenCalledTimes(2);
  });

  it("requests the final report using the native prepareStep system override", async () => {
    await searchViaFlash("q");
    const prep = options().prepareStep!;
    expect(await prep({ stepNumber: 198, steps: [], messages: [] })).toEqual({});
    const last = await prep({ stepNumber: 199, steps: [], messages: [] });
    expect(last?.system).toContain("MUST call searchReport");
    expect(last?.system).toContain("independent researcher");
    expect(last?.activeTools).toEqual(["searchReport"]);
    expect(last?.toolChoice).toBe("auto");
  });

  it("preserves planning and per-tool progress without consuming search quota in the progress callback", async () => {
    await searchViaFlash("q");
    const opts = options();
    expect(opts.system).toContain("Round 1 may use the query as-is");
    expect(opts.system).toContain("every later round must either reformulate");
    expect(opts.system).toContain("1-128 Unicode characters");
    expect(opts.onToolProgress!({ toolName: "web_search", input: {} })?.line).toContain("round 1");
    expect(opts.onToolProgress!({ toolName: "web_search", input: {} })?.line).toContain("round 1");
    await execute(opts, "web_search", { query: "q" });
    expect(opts.onToolProgress!({ toolName: "web_search", input: {} })?.line).toContain("round 2");
    expect(opts.onToolProgress!({ toolName: "webFetch", input: { url: "https://example.com/a" } })?.line).toContain("example.com");
    expect(opts.onToolProgress!({ toolName: "searchReport", input: {} })?.line).toContain("Compiling");
  });

  it("recovers an unfiled report as explicitly lower-confidence final text", async () => {
    mocks.runSubAgent.mockResolvedValue({ ok: true, text: "Partial findings" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await searchViaFlash("q");
    expect(out.answer).toBe("Partial findings");
    expect(out.recommendation).toContain("without filing the structured searchReport");
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
    expect(out.recommendation).toContain("lower-confidence");
    expect(out.sources).toEqual([{ title: "Docs", url: "https://example.com/docs" }]);
  });

  it("throws failed or empty timed-out runs for outer error classification", async () => {
    mocks.runSubAgent.mockResolvedValue({ ok: false, text: "", error: "HTTP 429" });
    await expect(searchViaFlash("q")).rejects.toThrow("HTTP 429");
    mocks.runSubAgent.mockResolvedValue({ ok: false, timedOut: true, text: "", error: "Deadline" });
    await expect(searchViaFlash("q")).rejects.toThrow("Deadline");
  });
});
