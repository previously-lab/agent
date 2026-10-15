import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createOctokitForTest,
  getOctokit,
  isGitHubRateLimitError,
  isGitHubReadTimeoutError,
  readDeadlineMs,
  resetOctokit,
  withGitHubReadBudget,
  type GitHubRateLimitError,
  type GitHubReadTimeoutError,
} from "@/lib/github/client";

describe("getOctokit", () => {
  beforeEach(() => {
    resetOctokit();
    delete process.env.GITHUB_TOKEN;
  });

  it("throws when GITHUB_TOKEN is not set", () => {
    expect(() => getOctokit()).toThrow("GITHUB_TOKEN");
  });

  it("returns an octokit instance when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "test-token-123";
    const octokit = getOctokit();
    expect(octokit).toBeDefined();
  });

  it("returns the same instance on repeated calls (singleton)", () => {
    process.env.GITHUB_TOKEN = "test-token-456";
    const a = getOctokit();
    const b = getOctokit();
    expect(a).toBe(b);
  });
});

describe("resetOctokit", () => {
  it("clears the singleton so next call creates a new instance", () => {
    process.env.GITHUB_TOKEN = "token-a";
    const a = getOctokit();
    resetOctokit();
    process.env.GITHUB_TOKEN = "token-b";
    const b = getOctokit();
    expect(a).not.toBe(b);
  });
});

// ─── Guardrails (rate-limit typing, circuit breaker, read deadlines) ──────

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(
  impl: () => Promise<Response>,
): { fetchImpl: typeof fetch; calls: () => number } {
  const fn = vi.fn(impl);
  return {
    fetchImpl: fn as unknown as typeof fetch,
    calls: () => fn.mock.calls.length,
  };
}

describe("github guardrails", () => {
  beforeEach(() => {
    resetOctokit();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-types a primary rate limit (403 + remaining 0) as typed, without retrying", async () => {
    const { fetchImpl, calls } = fakeFetch(async () =>
      jsonResponse(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      }),
    );
    const octokit = createOctokitForTest(fetchImpl);
    const err: unknown = await octokit
      .request("GET /rate_limit")
      .catch((e: unknown) => e);
    expect(isGitHubRateLimitError(err)).toBe(true);
    expect((err as GitHubRateLimitError).kind).toBe("primary");
    expect((err as GitHubRateLimitError).circuitOpen).toBe(false);
    // The throttle handler must NOT sleep+retry inside the request — one call.
    expect(calls()).toBe(1);
  });

  it("re-types a secondary rate limit (403 + retry-after + 'secondary rate')", async () => {
    const { fetchImpl } = fakeFetch(async () =>
      jsonResponse(
        403,
        { message: "You have exceeded a secondary rate limit" },
        { "retry-after": "60" },
      ),
    );
    const octokit = createOctokitForTest(fetchImpl);
    const err: unknown = await octokit
      .request("GET /rate_limit")
      .catch((e: unknown) => e);
    expect(isGitHubRateLimitError(err)).toBe(true);
    expect((err as GitHubRateLimitError).kind).toBe("secondary");
    expect((err as GitHubRateLimitError).retryAfterMs).toBe(60_000);
  });

  it("re-types a 429 as a secondary rate limit", async () => {
    const { fetchImpl, calls } = fakeFetch(async () =>
      jsonResponse(429, { message: "Too many requests" }),
    );
    const octokit = createOctokitForTest(fetchImpl);
    const err: unknown = await octokit
      .request("GET /rate_limit")
      .catch((e: unknown) => e);
    expect(isGitHubRateLimitError(err)).toBe(true);
    expect((err as GitHubRateLimitError).kind).toBe("secondary");
    expect(calls()).toBe(1);
  });

  it("opens the circuit after a rate limit — later calls fail fast, even on a fresh instance", async () => {
    const { fetchImpl, calls } = fakeFetch(async () =>
      jsonResponse(429, { message: "Too many requests" }),
    );
    const first = createOctokitForTest(fetchImpl);
    await first.request("GET /rate_limit").catch(() => {});

    const second = createOctokitForTest(fetchImpl);
    const err: unknown = await second
      .request("GET /rate_limit")
      .catch((e: unknown) => e);
    expect(isGitHubRateLimitError(err)).toBe(true);
    expect((err as GitHubRateLimitError).circuitOpen).toBe(true);
    // The fast-fail never touched the network — still exactly one fetch.
    expect(calls()).toBe(1);
  });

  it("a plain 403 (no rate-limit markers) passes through untouched", async () => {
    const { fetchImpl } = fakeFetch(async () =>
      jsonResponse(403, { message: "Forbidden" }),
    );
    const octokit = createOctokitForTest(fetchImpl);
    const err: unknown = await octokit
      .request("GET /rate_limit")
      .catch((e: unknown) => e);
    expect(isGitHubRateLimitError(err)).toBe(false);
    expect((err as { status?: number }).status).toBe(403);
  });

  it("a read exceeding the entry budget fails with GitHubReadTimeoutError", async () => {
    const { fetchImpl } = fakeFetch(() => new Promise<Response>(() => {})); // hangs
    const octokit = createOctokitForTest(fetchImpl);
    const err: unknown = await withGitHubReadBudget(
      () => octokit.request("GET /rate_limit"),
      20,
    ).catch((e: unknown) => e);
    expect(isGitHubReadTimeoutError(err)).toBe(true);
    const timeoutMs = (err as GitHubReadTimeoutError).timeoutMs;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(20);
  });

  it("a write is NOT deadline-bound — it completes past the read budget", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(jsonResponse(201, { ok: true })), 50),
        ),
    );
    const octokit = createOctokitForTest(fetchImpl);
    const res = await withGitHubReadBudget(
      () => octokit.request("POST /repos/o/r/issues", { title: "x" }),
      20,
    );
    expect(res.status).toBe(201);
  });
});

describe("readDeadlineMs", () => {
  it("returns the per-call cap when no budget is in scope", () => {
    expect(readDeadlineMs()).toBe(15_000);
  });

  it("a tighter budget remainder wins", () => {
    expect(readDeadlineMs(5)).toBe(5);
  });

  it("a spent budget still starts the read (1ms — fails on the next tick)", () => {
    expect(readDeadlineMs(0)).toBe(1);
    expect(readDeadlineMs(-50)).toBe(1);
  });

  it("a generous budget stays at the per-call cap", () => {
    expect(readDeadlineMs(60_000)).toBe(15_000);
  });
});
