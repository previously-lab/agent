import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GitHub-down simulation (L3) — the incident's symptom 2 ("页面一直转圈"),
 * proven end-to-end at the highest IN-PROCESS layer available:
 *
 *   real server actions (getArrivalState / getEpisodicState)
 *   → real entry read budget (withGitHubReadBudget)
 *   → real enumerate → getRepoTree → cachedFetch → readFile chain
 *   → real octokit guardrails (throttle never sleeps, typed rate-limit
 *     errors, the circuit breaker, the read deadline)
 *   → only the WIRE is faked (the octokit fetch boundary).
 *
 * COVERAGE HONESTY: this file proves the VERDICT layer — bounded typed
 * failures, the circuit, and the arrival gate's {kind:"failed"} collapse
 * that ChatPage turns into the failure card. The last mile (React rendering
 * the card) is NOT covered: the repo has no component-test harness (vitest
 * runs node env, no testing-library), and src/ is off-limits for a fault
 * injection switch, so a browser e2e cannot force GitHub failures either.
 * That layer is covered by tsc + review of chat-page.tsx's arrivalFailed
 * branch only.
 */

// No Data Cache store in vitest — the passthrough stub mirrors the real
// no-store fallback (same pattern as tests/lib/tools/readFile-cache.test.ts).
vi.mock("next/cache", () => ({
  unstable_cache: (cb: unknown) => cb,
  revalidateTag: () => {},
}));

const fetchMock = vi.hoisted(() => vi.fn());

// The wire is faked; every guardrail layer above it stays REAL.
vi.mock("@/lib/github/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/github/client")>();
  return {
    ...original,
    getOctokit: () =>
      original.createOctokitForTest(fetchMock as unknown as typeof fetch),
  };
});

import {
  isGitHubRateLimitError,
  isGitHubReadTimeoutError,
  resetOctokit,
} from "@/lib/github/client";
import { _resetDefaultBranchCache } from "@/lib/tools/batch-write";
import { getArrivalState, getEpisodicState } from "@/lib/episodic/actions";
import { raceArrivalVerdict } from "@/lib/chat/reconnect";

const rateLimitedFetch = async (): Promise<Response> =>
  new Response(
    JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
    { status: 429, headers: { "content-type": "application/json" } },
  );

const hangingFetch = (): Promise<Response> => new Promise<Response>(() => {});

const networkFailFetch = async (): Promise<Response> => {
  throw new TypeError("fetch failed");
};

/** A healthy GitHub answering the default-branch + tree chain (empty repo). */
const healthyFetch = async (...args: unknown[]): Promise<Response> => {
  const url = String(args[0]);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (url.includes("/git/ref/")) return json({ object: { sha: "headsha" } });
  if (url.includes("/git/trees/") && url.includes("recursive")) {
    return json({ tree: [], truncated: false });
  }
  if (url.includes("/git/trees/")) {
    return json({
      tree: [{ path: "memory", type: "tree", sha: "memsha" }],
      truncated: false,
    });
  }
  return json({ default_branch: "main" }); // repos.get
};

let savedStorage: string | undefined;

beforeEach(() => {
  savedStorage = process.env.STORAGE;
  process.env.STORAGE = "github";
  process.env.GITHUB_TOKEN = "github-down-test";
  resetOctokit(); // clears the module-level circuit breaker too
  _resetDefaultBranchCache();
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (savedStorage === undefined) delete process.env.STORAGE;
  else process.env.STORAGE = savedStorage;
  vi.restoreAllMocks();
});

describe("GitHub unavailable — entry actions fail fast and typed", () => {
  it("a 429 secondary limit rejects getArrivalState as GitHubRateLimitError — fast, after ONE network call (no throttle sleep)", async () => {
    fetchMock.mockImplementation(rateLimitedFetch);
    const t0 = Date.now();
    await expect(getArrivalState()).rejects.toSatisfy(isGitHubRateLimitError);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the circuit then serves the NEXT entry call without touching the network", async () => {
    fetchMock.mockImplementation(rateLimitedFetch);
    await expect(getArrivalState()).rejects.toSatisfy(isGitHubRateLimitError);

    fetchMock.mockClear();
    await expect(getEpisodicState()).rejects.toSatisfy(
      (e) => isGitHubRateLimitError(e) && e.circuitOpen,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a hard network error is bounded too — the platform retry caps at 3, then the action rejects", async () => {
    // REAL wall-clock: octokit's retry backoff is real seconds (~15s here).
    // Fake timers are banned in this file — the throttle plugin's limiter
    // groups are module-level singletons shared across octokit instances, and
    // a fake-clock timestamp left in the shared limiter's scheduling state
    // wedges it for every later test in the process (observed: subsequent
    // actions hang before the first fetch, fetchCalls=0).
    fetchMock.mockImplementation(networkFailFetch);
    await expect(getArrivalState()).rejects.toThrow();
    // Not a rate limit — no typed error — but NOT a storm: octokit's retry
    // plugin bounds it at 1 + 3 attempts, and nothing sleeps to a reset.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    // …and the circuit stays CLOSED for non-rate-limit failures: the next
    // call still reaches the wire.
    fetchMock.mockClear();
    fetchMock.mockImplementation(healthyFetch);
    await expect(getArrivalState()).resolves.toEqual({
      mode: "briefing",
    });
    expect(fetchMock).toHaveBeenCalled();
  }, 30_000);

  it("a HUNG GitHub read rejects with GitHubReadTimeoutError at the read deadline — the page can never spin forever", async () => {
    fetchMock.mockImplementation(hangingFetch);
    const t0 = Date.now();
    await expect(getArrivalState()).rejects.toSatisfy(
      isGitHubReadTimeoutError,
    );
    // Real wall-clock proof of the bound: the per-call cap (15s) fires well
    // inside the entry budget (20s).
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(20_000);
  }, 25_000);
});

describe("arrival gate under GitHub-down (the verdict layer of the failure card)", () => {
  it("a hung memory service collapses to {kind:'failed'} at the gate timeout — bounded, the failure card's trigger", async () => {
    fetchMock.mockImplementation(hangingFetch);
    // The gate (10s here) fires BEFORE the read deadline (15s) — exactly
    // the composition ChatPage runs: raceArrivalVerdict(resolveArrival(…)).
    const action = getArrivalState();
    const t0 = Date.now();
    await expect(raceArrivalVerdict(action, 10_000)).resolves.toEqual({
      kind: "failed",
    });
    expect(Date.now() - t0).toBeLessThan(11_000);
    // Drain the loser: its own read deadline (15s) still bounds it even
    // after the gate has moved on.
    await expect(action).rejects.toSatisfy(isGitHubReadTimeoutError);
  }, 25_000);

  it("a rate-limited memory service rejects typed and fast; resolveArrival's own catch contract turns that into a neutral briefing, not a spin", async () => {
    fetchMock.mockImplementation(rateLimitedFetch);
    const t0 = Date.now();
    // resolveArrival is module-private in chat-page.tsx; this replicates its
    // exact contract verbatim (chat-page.tsx: getArrivalState(persona).catch(
    // () => ({ mode: "briefing" }))) so the gate receives a resolved verdict.
    const verdict = await raceArrivalVerdict(
      getArrivalState().catch(() => ({ mode: "briefing" as const })),
      10_000,
    );
    expect(verdict).toEqual({ kind: "ok", verdict: { mode: "briefing" } });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("control — the harness itself is sound", () => {
  it("a healthy GitHub answers getArrivalState (empty repo → briefing)", async () => {
    fetchMock.mockImplementation(healthyFetch);
    await expect(getArrivalState()).resolves.toEqual({ mode: "briefing" });
  });
});
