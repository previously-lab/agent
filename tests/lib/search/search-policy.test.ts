import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/search/deepseek-web", async (original) => ({
  ...await original<typeof import("@/lib/search/deepseek-web")>(),
  deepseekWebSearch: mocks.search,
}));
import {
  SearchRunPolicy,
  normalizeSearchQuery,
  STANDARD_SEARCH_OPERATION_LIMIT,
  SCOUT_SEARCH_OPERATION_LIMIT,
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

describe("SearchRunPolicy limits", () => {
  it("exports the decided operation limits", () => {
    expect(STANDARD_SEARCH_OPERATION_LIMIT).toBe(12);
    expect(SCOUT_SEARCH_OPERATION_LIMIT).toBe(4);
  });

  it("sends the canonical normalized query to the API", async () => {
    const policy = new SearchRunPolicy(12);
    await policy.search({ query: "  foo   bar " });
    expect(mocks.search).toHaveBeenCalledWith(
      { query: "foo bar", count: undefined },
      undefined,
      { originalQuestion: undefined },
    );
  });

  it("reuses a successful result for the same normalized query and effective count", async () => {
    const policy = new SearchRunPolicy(12);
    const first = await policy.search({ query: "foo   bar" });
    const second = await policy.search({ query: "  foo bar ", count: 10 });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(second.results).toEqual(first.results);
    expect(second.note).toMatch(/no new Search API operation/i);
    expect(second.note).toMatch(/same normalized query and result count/i);
    expect(policy.getStats()).toMatchObject({
      operationLimit: 12,
      operationsStarted: 1,
      operationsSucceeded: 1,
      duplicateHits: 1,
      inFlightHits: 0,
      exhausted: false,
    });
  });

  it("allows a larger count to expand under the remaining operation budget", async () => {
    const policy = new SearchRunPolicy(12);
    await policy.search({ query: "expanding query", count: 1 });
    await policy.search({ query: "  expanding   query ", count: 10 });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.search).toHaveBeenNthCalledWith(
      2,
      { query: "expanding query", count: 10 },
      undefined,
      { originalQuestion: undefined },
    );
    expect(policy.getStats()).toMatchObject({ operationsStarted: 2, operationsSucceeded: 2, duplicateHits: 0 });
  });

  it("reuses a valid empty result on repeat and reports it honestly", async () => {
    mocks.search.mockResolvedValue({ results: [] });
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
    await expect(policy.search({ query: "flaky" })).rejects.toThrow("HTTP 429");
    const retry = await policy.search({ query: "flaky" });
    expect(retry.results).toEqual(hit.results);
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(policy.getStats()).toMatchObject({ operationsStarted: 2, operationsSucceeded: 1 });
  });

  it("does not cache a malformed successful upstream response", async () => {
    mocks.search.mockRejectedValueOnce(new Error("Malformed HTTP 200 response"));
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
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
    const policy = new SearchRunPolicy(12);
    await expect(policy.search({ query: "late" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(policy.getStats().operationsStarted).toBe(0);
  });

  it("caps NEW operations and keeps cached reuse available after the cap", async () => {
    const policy = new SearchRunPolicy(4);
    for (let i = 0; i < 4; i += 1) {
      await policy.search({ query: `q${i}` });
    }
    expect(policy.getStats().operationsStarted).toBe(4);
    const rejected = await policy.search({ query: "one more" });
    expect(rejected.results).toEqual([]);
    expect(rejected.note).toMatch(/budget exhausted/i);
    expect(rejected.note).toMatch(/evidence already gathered/i);
    expect(rejected.note).toMatch(/follow-up/i);
    const stats = policy.getStats();
    expect(stats.exhausted).toBe(true);
    // Reuse of an earlier success still works after the cap, for free.
    const reused = await policy.search({ query: "q0" });
    expect(reused.results).toEqual(hit.results);
    expect(reused.note).toMatch(/no new Search API operation/i);
    expect(policy.getStats().operationsStarted).toBe(4);
    expect(policy.getStats().duplicateHits).toBe(1);
  });

  it("consumes a slot for every started operation even when it fails", async () => {
    mocks.search.mockRejectedValue(new Error("HTTP 500"));
    const policy = new SearchRunPolicy(1);
    await expect(policy.search({ query: "a" })).rejects.toThrow("HTTP 500");
    const capped = await policy.search({ query: "b" });
    expect(capped.results).toEqual([]);
    expect(capped.note).toMatch(/budget exhausted/i);
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it("scopes dedup to the instance: a second policy searches the same query anew", async () => {
    const one = new SearchRunPolicy(12);
    const two = new SearchRunPolicy(12);
    await one.search({ query: "same" });
    await two.search({ query: "same" });
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });

  it("keeps stats query-free", async () => {
    const policy = new SearchRunPolicy(12);
    await policy.search({ query: "needle-query-xyz" });
    expect(JSON.stringify(policy.getStats())).not.toContain("needle-query-xyz");
  });

  it("threads the run question through as the ori_question hint", async () => {
    const policy = new SearchRunPolicy(12, "the triggering question");
    await policy.search({ query: "q" });
    expect(mocks.search).toHaveBeenCalledWith(
      { query: "q", count: undefined },
      undefined,
      { originalQuestion: "the triggering question" },
    );
  });

  it("hasSeen uses the same normalized query and effective count identity", async () => {
    let resolve!: (v: typeof hit) => void;
    mocks.search.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const policy = new SearchRunPolicy(12);
    expect(policy.hasSeen("a  b")).toBe(false);
    const pending = policy.search({ query: "a b" });
    expect(policy.hasSeen(" a   b ", 10)).toBe(true);
    expect(policy.hasSeen("a b", 1)).toBe(false);
    resolve(hit);
    await pending;
    expect(policy.hasSeen("a b")).toBe(true);
    expect(policy.hasSeen("a b", 50)).toBe(false);
  });
});
