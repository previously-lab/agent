import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/search/deepseek-web", async (original) => ({
  ...await original<typeof import("@/lib/search/deepseek-web")>(),
  deepseekWebSearch: mocks.search,
}));
import {
  SearchRunPolicy,
  normalizeSearchQuery,
} from "@/lib/search/search-policy";

const hit = { results: [{ title: "T", url: "https://example.com/t", summary: "S" }] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.search.mockResolvedValue(hit);
});

describe("normalizeSearchQuery", () => {
  it("trims and collapses whitespace outside quoted phrases to one ASCII space", () => {
    expect(normalizeSearchQuery("  foo\t bar\nbaz  ")).toBe("foo bar baz");
    expect(normalizeSearchQuery("a    b     c")).toBe("a b c");
  });

  it("preserves whitespace inside double-quoted exact phrases", () => {
    expect(normalizeSearchQuery('foo   "exact   phrase"   bar')).toBe('foo "exact   phrase" bar');
    expect(normalizeSearchQuery('"  padded  "')).toBe('"  padded  "');
  });

  it("preserves operators, negation, dates and URLs exactly", () => {
    const query = "site:example.com -site:spam.example lang:en after:2024-01-01 before:2026-01-01 (cats OR dogs) -stray https://example.com/a?q=1  ";
    expect(normalizeSearchQuery(query)).toBe(query.trim());
  });

  it("toggles quoting per double quote and keeps later text exact", () => {
    expect(normalizeSearchQuery('a "b c" d "e  f" g')).toBe('a "b c" d "e  f" g');
  });
});

describe("SearchRunPolicy", () => {
  it("sends the canonical normalized query to the API", async () => {
    const policy = new SearchRunPolicy();
    await policy.search({ query: "  foo   bar " });
    expect(mocks.search).toHaveBeenCalledWith(
      { query: "foo bar", count: undefined },
      undefined,
    );
  });

  it("reuses a successful result for the same normalized query and effective count", async () => {
    const policy = new SearchRunPolicy();
    const first = await policy.search({ query: "foo   bar" });
    const second = await policy.search({ query: "  foo bar ", count: 10 });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(second.results).toEqual(first.results);
    expect(second.note).toMatch(/no new Search API operation/i);
    expect(second.note).toMatch(/same normalized query and result count/i);
    expect(policy.getStats()).toMatchObject({
      operationsStarted: 1,
      operationsSucceeded: 1,
      duplicateHits: 1,
      inFlightHits: 0,
    });
  });

  it("allows a larger count to expand under the remaining operation budget", async () => {
    const policy = new SearchRunPolicy();
    await policy.search({ query: "expanding query", count: 1 });
    await policy.search({ query: "  expanding   query ", count: 10 });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.search).toHaveBeenNthCalledWith(
      2,
      { query: "expanding query", count: 10 },
      undefined,
    );
    expect(policy.getStats()).toMatchObject({ operationsStarted: 2, operationsSucceeded: 2, duplicateHits: 0 });
  });

  it("reuses a valid empty result on repeat and reports it honestly", async () => {
    mocks.search.mockResolvedValue({ results: [] });
    const policy = new SearchRunPolicy();
    const first = await policy.search({ query: "nothing here" });
    expect(first.note).toMatch(/returned no results/i);
    expect(first.note).toMatch(/reformulat/i);
    const second = await policy.search({ query: "nothing here" });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(second.results).toEqual([]);
    expect(second.note).toMatch(/no new Search API operation/i);
  });

  it("coalesces concurrent duplicates onto one in-flight operation", async () => {
    let resolve!: (v: typeof hit) => void;
    mocks.search.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const policy = new SearchRunPolicy();
    const a = policy.search({ query: "shared query" });
    const b = policy.search({ query: "  shared   query", count: 10 });
    resolve(hit);
    const [ra, rb] = await Promise.all([a, b]);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(ra.results).toEqual(hit.results);
    expect(rb.results).toEqual(hit.results);
    expect(rb.note).toMatch(/no new Search API operation/i);
    expect(rb.note).toMatch(/exact query and result count/i);
    expect(policy.getStats().inFlightHits).toBe(1);
    expect(policy.getStats().operationsStarted).toBe(1);
  });

  it("never caches a failure: a later invocation retries while budget remains", async () => {
    mocks.search.mockRejectedValueOnce(new Error("HTTP 429"));
    const policy = new SearchRunPolicy();
    await expect(policy.search({ query: "flaky" })).rejects.toThrow("HTTP 429");
    const retry = await policy.search({ query: "flaky" });
    expect(retry.results).toEqual(hit.results);
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(policy.getStats()).toMatchObject({ operationsStarted: 2, operationsSucceeded: 1 });
  });

  it("does not cache a malformed successful upstream response", async () => {
    mocks.search.mockRejectedValueOnce(new Error("Malformed HTTP 200 response"));
    const policy = new SearchRunPolicy();
    await expect(policy.search({ query: "malformed" })).rejects.toThrow("Malformed HTTP 200");
    await expect(policy.search({ query: "malformed" })).resolves.toMatchObject({ results: hit.results });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(policy.getStats()).toMatchObject({ operationsStarted: 2, operationsSucceeded: 1 });
  });

  it("evicts an aborted in-flight entry and does not cache it", async () => {
    const controller = new AbortController();
    mocks.search.mockImplementation(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise((_r, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const policy = new SearchRunPolicy();
    const pending = policy.search({ query: "abortable" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // The pending entry is gone: a concurrent-style repeat starts fresh.
    mocks.search.mockResolvedValue(hit);
    const again = await policy.search({ query: "abortable" });
    expect(again.results).toEqual(hit.results);
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });

  it("rejects an already-cancelled caller even when the exact request is cached", async () => {
    const policy = new SearchRunPolicy();
    await policy.search({ query: "warm cache", count: 3 });
    const controller = new AbortController();
    controller.abort();
    await expect(policy.search({ query: " warm   cache ", count: 3 }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(policy.getStats().duplicateHits).toBe(0);
  });

  it("does not cache a late success that arrives after owner cancellation", async () => {
    let resolve!: (v: typeof hit) => void;
    mocks.search.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const controller = new AbortController();
    const policy = new SearchRunPolicy();
    const pending = policy.search({ query: "late success", count: 2 }, controller.signal);
    controller.abort();
    resolve(hit);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    mocks.search.mockResolvedValue(hit);
    await policy.search({ query: "late success", count: 2 });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(policy.getStats()).toMatchObject({ operationsStarted: 2, operationsSucceeded: 1 });
  });

  it("lets a joiner cancel its wait without cancelling or poisoning the shared request", async () => {
    let resolve!: (v: typeof hit) => void;
    mocks.search.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const policy = new SearchRunPolicy();
    const primary = policy.search({ query: "shared cancellation", count: 4 });
    const controller = new AbortController();
    const joined = policy.search({ query: " shared   cancellation ", count: 4 }, controller.signal);
    const joinedRejection = expect(joined).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await joinedRejection;

    resolve(hit);
    await expect(primary).resolves.toMatchObject({ results: hit.results });
    await policy.search({ query: "shared cancellation", count: 4 });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(policy.getStats()).toMatchObject({
      operationsStarted: 1,
      operationsSucceeded: 1,
      inFlightHits: 1,
      duplicateHits: 1,
    });
  });

  it("throws before consuming an operation when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const policy = new SearchRunPolicy();
    await expect(policy.search({ query: "late" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(policy.getStats().operationsStarted).toBe(0);
  });

  it("allows more than the former standard quota while still coalescing duplicates", async () => {
    const policy = new SearchRunPolicy();
    for (let i = 0; i < 15; i++) await policy.search({ query: `query ${i}` });
    await policy.search({ query: "query 14" });
    expect(mocks.search).toHaveBeenCalledTimes(15);
    expect(policy.getStats().duplicateHits).toBe(1);
  });

  it("scopes dedup to the instance: a second policy searches the same query anew", async () => {
    const one = new SearchRunPolicy();
    const two = new SearchRunPolicy();
    await one.search({ query: "same" });
    await two.search({ query: "same" });
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });

  it("keeps stats query-free", async () => {
    const policy = new SearchRunPolicy();
    await policy.search({ query: "needle-query-xyz" });
    expect(JSON.stringify(policy.getStats())).not.toContain("needle-query-xyz");
  });

});
