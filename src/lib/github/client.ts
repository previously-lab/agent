import { Octokit } from "octokit";
import { AsyncLocalStorage } from "node:async_hooks";

// ─── Guardrail tunables (registered in doc/reviews/housekeeping-and-page-hang.md §实施) ───

/**
 * Hard deadline for ONE GitHub read (GET/HEAD), covering everything the
 * octokit plugin layer can add before/around the HTTP call (Bottleneck
 * queueing, throttling waits) — not just the wire. Normal p99 is <2s; 15s is
 * the "something is wrong" line, not a performance target. Writes are NOT
 * covered: a timed-out write would be ambiguous (the ref may have moved), so
 * writes rely on the 30s per-request timeout + conflict fail-fast instead.
 */
export const GITHUB_READ_CALL_TIMEOUT_MS = 15_000;

/**
 * Total GitHub-read budget for ONE entry point (a page load or a chat POST is
 * dozens of reads). Each base read still caps at GITHUB_READ_CALL_TIMEOUT_MS;
 * the budget shrinks that cap to whatever the entry point has left, so a
 * composite load fails in ~budget time instead of dying at the platform's
 * 300s wall. Nested budgets take the tighter deadline.
 */
export const GITHUB_READ_BUDGET_MS = 20_000;

/**
 * Minimum circuit-breaker window after a rate-limit hit. GitHub's longer
 * retry-after/reset hint takes precedence. While open EVERY GitHub
 * call fails fast with GitHubRateLimitError (circuitOpen: true) instead of
 * spending more quota. Per-instance state (a lambda has its own); a fresh hit
 * re-extends the window.
 */
export const GITHUB_CIRCUIT_OPEN_MS = 60_000;

// ─── Typed failures ───────────────────────────────────────────────────────

export type GitHubRateLimitKind = "primary" | "secondary";

/**
 * A GitHub rate limit (primary: hourly quota exhausted, x-ratelimit-remaining
 * 0; secondary/abuse: burst limits, 429 or "secondary rate" message), or a
 * circuit-breaker fast-fail after one (circuitOpen: true — no request was
 * sent). Callers can branch on this type to degrade instead of retrying.
 */
export class GitHubRateLimitError extends Error {
  override readonly name = "GitHubRateLimitError";

  constructor(
    message: string,
    /** Which limit family tripped; on a circuit-open error, the family's of the hit that opened it. */
    readonly kind: GitHubRateLimitKind,
    readonly status: number,
    /** GitHub's own wait hint (retry-after header / reset), when it sent one. */
    readonly retryAfterMs: number | undefined,
    /** True when the circuit breaker threw this without touching the network. */
    readonly circuitOpen: boolean,
  ) {
    super(message);
  }
}

/** A GitHub read exceeded its deadline (per-call cap or the entry budget). */
export class GitHubReadTimeoutError extends Error {
  override readonly name = "GitHubReadTimeoutError";

  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
  }
}

export function isGitHubRateLimitError(
  err: unknown,
): err is GitHubRateLimitError {
  return err instanceof GitHubRateLimitError;
}

export function isGitHubReadTimeoutError(
  err: unknown,
): err is GitHubReadTimeoutError {
  return err instanceof GitHubReadTimeoutError;
}

// ─── The read budget (AsyncLocalStorage-scoped) ───────────────────────────

interface GitHubReadBudget {
  readonly deadline: number;
}

const readBudgetStorage = new AsyncLocalStorage<GitHubReadBudget>();

/**
 * Run `fn` with a total GitHub-read deadline. Every base read inside `fn`
 * (anything going through this module's octokit) races its own call against
 * the remaining budget, so the composite operation fails with
 * GitHubReadTimeoutError instead of hanging to the platform timeout.
 */
export async function withGitHubReadBudget<T>(
  fn: () => Promise<T>,
  budgetMs: number = GITHUB_READ_BUDGET_MS,
): Promise<T> {
  const parent = readBudgetStorage.getStore();
  const deadline = parent
    ? Math.min(parent.deadline, Date.now() + budgetMs)
    : Date.now() + budgetMs;
  return readBudgetStorage.run({ deadline }, fn);
}

/**
 * The deadline a single read gets right now: the per-call cap, tightened to
 * the budget's remainder when one is in scope (1ms when the budget is already
 * spent — the read fails on the next tick instead of never starting).
 * Pure — unit-tested.
 */
export function readDeadlineMs(remainingBudgetMs?: number): number {
  if (remainingBudgetMs === undefined) return GITHUB_READ_CALL_TIMEOUT_MS;
  return Math.max(
    1,
    Math.min(GITHUB_READ_CALL_TIMEOUT_MS, Math.floor(remainingBudgetMs)),
  );
}

// ─── Rate-limit classification + circuit breaker ─────────────────────────

let circuitOpenUntil = 0;
let circuitOpenKind: GitHubRateLimitKind = "secondary";

/**
 * Recognize GitHub's rate-limit failures and re-type them. A plain 403
 * (permissions, SSO, repo rules) is NOT a rate limit and passes through
 * untouched — only `x-ratelimit-remaining: 0` (primary), 429, a "secondary
 * rate" message, or a 403 carrying `retry-after` (abuse) qualify.
 */
function asRateLimitError(error: unknown): GitHubRateLimitError | null {
  if (!error || typeof error !== "object") return null;
  const e = error as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Record<string, string | undefined> };
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status !== 403 && status !== 429) return null;
  const headers = e.response?.headers ?? {};
  const message = typeof e.message === "string" ? e.message : "";
  const isPrimary = headers["x-ratelimit-remaining"] === "0";
  const isSecondary =
    status === 429 ||
    /secondary rate/i.test(message) ||
    (!isPrimary && headers["retry-after"] !== undefined);
  if (!isPrimary && !isSecondary) return null;
  const kind: GitHubRateLimitKind = isPrimary ? "primary" : "secondary";
  let retryAfterMs: number | undefined;
  const retryAfterSeconds = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    retryAfterMs = retryAfterSeconds * 1000;
  } else if (isPrimary) {
    const reset = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(reset) && reset > 0) {
      retryAfterMs = Math.max(0, reset * 1000 - Date.now());
    }
  }
  return new GitHubRateLimitError(
    `GitHub rate limit (${kind}): ${message}`,
    kind,
    status,
    retryAfterMs,
    false,
  );
}

/**
 * Wire the guardrails onto one octokit instance:
 *
 * 1. Throttle never sleeps. The octokit bundle's default onRateLimit /
 *    onSecondaryRateLimit handlers sleep until the quota reset (up to an
 *    hour) and retry once — inside the request, invisible to every timeout
 *    above it. Ours return false: the failure surfaces immediately.
 * 2. Rate-limit failures are re-typed (hook.error) and trip the circuit
 *    breaker.
 * 3. Reads carry a hard deadline (hook.wrap, outermost — it bounds plugin
 *    queueing too) with a real AbortSignal, so the wire request is cancelled,
 *    not just abandoned. Writes skip the deadline (a timed-out write is
 *    ambiguous) but still hit the breaker.
 */
function installGuardrails(octokit: Octokit): void {
  octokit.hook.wrap("request", async (request, options) => {
    const now = Date.now();
    if (now < circuitOpenUntil) {
      throw new GitHubRateLimitError(
        `GitHub circuit breaker open — failing fast for ${Math.ceil((circuitOpenUntil - now) / 1000)}s more (opened by a ${circuitOpenKind} rate limit)`,
        circuitOpenKind,
        403,
        circuitOpenUntil - now,
        true,
      );
    }

    const method = (options.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return request(options);
    }

    const budget = readBudgetStorage.getStore();
    const deadlineMs = readDeadlineMs(
      budget ? budget.deadline - now : undefined,
    );
    const controller = new AbortController();
    const callerSignal = options.request?.signal ?? undefined;
    options.request = {
      ...options.request,
      signal: callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request(options),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new GitHubReadTimeoutError(
                `GitHub read timed out after ${deadlineMs}ms: ${method} ${options.url}`,
                deadlineMs,
              ),
            );
          }, deadlineMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });

  octokit.hook.error("request", (error) => {
    // Already-typed guardrail failures (incl. circuit-open fast-fails thrown
    // by the wrap above) pass through — re-classifying them would strip the
    // circuitOpen flag (the circuit message itself matches /secondary rate/i).
    if (error instanceof GitHubRateLimitError) throw error;
    const rateLimited = asRateLimitError(error);
    if (!rateLimited) throw error;
    const openMs = Math.max(GITHUB_CIRCUIT_OPEN_MS, rateLimited.retryAfterMs ?? 0);
    circuitOpenUntil = Date.now() + openMs;
    circuitOpenKind = rateLimited.kind;
    console.warn(
      `[github] ${rateLimited.kind} rate limit hit — circuit open for ${Math.ceil(openMs / 1000)}s` +
        (rateLimited.retryAfterMs !== undefined
          ? ` (GitHub asks to wait ${Math.ceil(rateLimited.retryAfterMs / 1000)}s)`
          : ""),
    );
    throw rateLimited;
  });
}

// ─── The singleton ────────────────────────────────────────────────────────

export interface GitHubRequestMetric {
  method: string;
  /** Route template only: no owner, repo, file path, query or credentials. */
  endpoint: string;
  status: number | "network-error";
  elapsedMs: number;
  remaining?: number;
  resetAt?: number;
  retryAfterSeconds?: number;
}

function endpointTemplate(input: string): string {
  try {
    const path = new URL(input).pathname;
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "/repos/:owner/:repo";
    const suffix = path.replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/:owner/:repo");
    return suffix
      .replace(/\/contents(?:\/.*)?$/, "/contents/:path")
      .replace(/\/(trees|blobs|commits|refs?|branches)\/.*$/, "/$1/:object");
  } catch {
    return "unknown";
  }
}

function measuredFetch(
  fetchImpl: typeof fetch,
  observe?: (metric: GitHubRequestMetric) => void,
): typeof fetch {
  return async (input, init) => {
    const startedAt = performance.now();
    let response: Response | undefined;
    try {
      response = await fetchImpl(input, init);
      return response;
    } finally {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const metric: GitHubRequestMetric = {
        method: method.toUpperCase(), endpoint: endpointTemplate(url),
        status: response?.status ?? "network-error",
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      for (const [header, field] of [
        ["x-ratelimit-remaining", "remaining"],
        ["x-ratelimit-reset", "resetAt"],
        ["retry-after", "retryAfterSeconds"],
      ] as const) {
        const value = response?.headers.get(header);
        if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
          metric[field] = Number(value);
        }
      }
      // Measure the wire, inside retry/throttle plugins: one record means one
      // actual HTTP attempt. Cache misses, queueing and circuit fast-fails
      // never masquerade as requests. Observability must not fail the call.
      try {
        observe?.(metric);
        console.log(`[github-request] ${JSON.stringify(metric)}`);
      } catch { /* best effort */ }
    }
  };
}

function buildOctokit(
  token: string,
  fetchImpl?: typeof fetch,
  observe?: (metric: GitHubRequestMetric) => void,
): Octokit {
  const octokit = new Octokit({
    auth: token,
    request: {
      timeout: 30_000, // 30s per-request cap — prevents hanging API calls
      fetch: measuredFetch(fetchImpl ?? globalThis.fetch, observe),
    },
    // Rate limits (403/429) and ref conflicts (422) fail immediately — the
    // retry plugin's default already skips 403/422; 429 is added so secondary
    // limits reach our classifier without three backoff round-trips first.
    retry: {
      doNotRetry: [400, 401, 403, 404, 410, 422, 451, 429],
    },
    throttle: {
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
  });
  installGuardrails(octokit);
  return octokit;
}

let octokitInstance: Octokit | null = null;

/**
 * Get the singleton GitHub client instance.
 * Requires GITHUB_TOKEN environment variable.
 * Throws if token is not configured.
 */
export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is not set");
    }
    octokitInstance = buildOctokit(token);
  }
  return octokitInstance;
}

/**
 * Test seam: a guardrail-wired client riding a fake fetch — never touches the
 * network. The circuit breaker is module state shared across instances;
 * resetOctokit() clears it.
 */
export function createOctokitForTest(
  fetchImpl: typeof fetch,
  observe?: (metric: GitHubRequestMetric) => void,
): Octokit {
  return buildOctokit("test-token", fetchImpl, observe);
}

/**
 * Reset the singleton and the circuit breaker (useful for testing).
 */
export function resetOctokit(): void {
  octokitInstance = null;
  circuitOpenUntil = 0;
}
