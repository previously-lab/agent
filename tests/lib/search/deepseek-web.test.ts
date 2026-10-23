import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const credentials = vi.hoisted(() => ({ key: vi.fn() }));
vi.mock("@/lib/deepseek/credentials", () => ({ deepseekApiKey: credentials.key }));
import { deepseekWebSearch, webSearchInputSchema } from "@/lib/search/deepseek-web";

const fetchMock = vi.fn<typeof fetch>();
const result = { title: "Official docs", url: "https://example.com/docs", snippet: "Evidence", summary: "More evidence", site_name: null, date: null };
const response = () => new Response(JSON.stringify({ results: [result] }), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.resetAllMocks();
  credentials.key.mockReturnValue("test-key");
  fetchMock.mockResolvedValue(response());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("DeepSeek native Search API", () => {
  it("posts the unchanged query to the fixed endpoint with a server-resolved credential", async () => {
    const query = 'site:example.com "exact phrase"';
    expect(await deepseekWebSearch({ query })).toEqual({ results: [result] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toEqual({ query, count: 10, need_content: false });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(credentials.key).toHaveBeenCalledTimes(1);
  });

  it("treats an empty result set as a normal success without retries", async () => {
    fetchMock.mockResolvedValue(new Response('{"results":[]}'));
    expect(await deepseekWebSearch({ query: "q", count: 1 })).toEqual({ results: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["", "  \n\t", "q".repeat(129), "😀".repeat(129)])("rejects invalid query before credential or HTTP access", async (query) => {
    await expect(deepseekWebSearch({ query })).rejects.toThrow("1-128 Unicode characters");
    expect(credentials.key).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts 128 astral Unicode characters and preserves their exact value", async () => {
    const query = "😀".repeat(128);
    await deepseekWebSearch({ query, count: 50 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ query, count: 50, need_content: false });
  });

  it.each([0, -1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid result count %s", async (count) => {
    await expect(deepseekWebSearch({ query: "q", count })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(webSearchInputSchema.safeParse({ query: "q", count }).success).toBe(false);
  });

  it.each([408, 429, 500, 503])("retries HTTP %s with a bounded attempt count", async (status) => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response("private diagnostics", { status }));
    const pending = expect(deepseekWebSearch({ query: "q" })).rejects.toThrow(`DeepSeek search failed (HTTP ${status}).`);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(credentials.key).toHaveBeenCalledTimes(3);
  });

  it("honors a short Retry-After and re-reads credentials for the retry", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } })).mockResolvedValueOnce(response());
    const pending = deepseekWebSearch({ query: "q" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    credentials.key.mockReturnValue("updated-key");
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ results: [result] });
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({ Authorization: "Bearer updated-key" });
  });

  it("does not shorten a server cooldown beyond its local retry bound", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "60" } }));
    await expect(deepseekWebSearch({ query: "q" })).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402, 403, 404, 422])("never retries deterministic HTTP %s or exposes its response body", async (status) => {
    fetchMock.mockResolvedValue(new Response("test-key secret diagnostics", { status }));
    await expect(deepseekWebSearch({ query: "q" })).rejects.toThrow(`DeepSeek search failed (HTTP ${status}).`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed successful response or an ambiguous network failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not JSON"));
    await expect(deepseekWebSearch({ query: "q" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(deepseekWebSearch({ query: "q" })).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["javascript:alert(1)", "file:///private", "https://user:pass@example.com/"])("rejects unsafe source URL %s", async (url) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ ...result, url }] })));
    await expect(deepseekWebSearch({ query: "q" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before HTTP if the local credential is unavailable", async () => {
    credentials.key.mockImplementation(() => { throw new Error("Configure a DeepSeek API key"); });
    await expect(deepseekWebSearch({ query: "q" })).rejects.toThrow("Configure a DeepSeek API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start a request after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(deepseekWebSearch({ query: "q" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the retry wait without starting another request", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    const controller = new AbortController();
    const pending = expect(deepseekWebSearch({ query: "q" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
