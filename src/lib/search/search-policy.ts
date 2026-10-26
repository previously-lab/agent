/**
 * Per-run search policy: canonical query normalization, dedup of repeated
 * queries, and a hard cap on NEW DeepSeek Search operations per research run.
 *
 * One policy instance lives inside ONE searchViaFlash invocation — there is no
 * module-level or cross-run cache. The cap bounds only new search operations;
 * reusing an already-successful result (or sharing an in-flight one) stays
 * available after the cap, and never consumes a slot.
 */
import { z } from "zod";
import {
  deepseekWebSearch,
  webSearchInputSchema,
  type DeepSeekSearchResult,
} from "@/lib/search/deepseek-web";

/** New search operations a standard research run may start. */
export const STANDARD_SEARCH_OPERATION_LIMIT = 12;

/** New search operations a scout (parallel fan-out leg) run may start. */
export const SCOUT_SEARCH_OPERATION_LIMIT = 4;

/** Query-free, secret-free per-run accounting. Not a billing ledger. */
export interface SearchRunStats {
  operationLimit: number;
  operationsStarted: number;
  operationsSucceeded: number;
  duplicateHits: number;
  inFlightHits: number;
  /** True once a NEW request was rejected by the operation cap. */
  exhausted: boolean;
}

/** What the policy hands back: the API-shaped result plus an optional note. */
export type PolicySearchOutput = DeepSeekSearchResult & { note?: string };

const NO_RESULTS_NOTE =
  "This search returned no results. Consider reformulating the query — " +
  "different keywords, fewer operators, or a broader phrasing.";

const REUSE_NOTE =
  "No new Search API operation was performed — reusing the earlier " +
  "successful result for the same normalized query and result count from this run.";

const IN_FLIGHT_NOTE =
  "No new Search API operation was performed — this exact query and result " +
  "count are already being searched in this run; sharing that in-flight search.";

function exhaustedNote(limit: number): string {
  return (
    `Search operation budget exhausted (${limit} new search operations this run) — ` +
    "no new search was performed for this query. Synthesize your answer from " +
    "the evidence already gathered; deeper coverage requires a separate, " +
    "deliberately scoped follow-up research run."
  );
}

/**
 * Canonical form for dedup and for the query actually sent to the API: trim,
 * and collapse whitespace OUTSIDE double-quoted exact phrases to one ASCII
 * space. Whitespace inside quoted phrases, all non-whitespace characters and
 * operator order (site:, -site:, lang:, after:, before:, OR, quotes,
 * negation) are preserved byte-for-byte. No lowercasing, no operator
 * stripping, no date or URL manipulation.
 */
export function normalizeSearchQuery(query: string): string {
  let out = "";
  let inQuote = false;
  let pendingSpace = false;
  for (const ch of query) {
    if (ch === '"') {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && /\s/u.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch;
  }
  return out;
}

type SearchInput = z.infer<typeof webSearchInputSchema>;

function requestIdentity(query: string, count?: number): { query: string; key: string } {
  const normalized = normalizeSearchQuery(query);
  return { query: normalized, key: JSON.stringify([normalized, count ?? 10]) };
}

/** Let one joiner cancel its wait without cancelling the shared operation.
 * Both settlement paths stay handled after the joiner stops waiting. */
function waitForInFlight<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * One instance per research run. Dedup keys are the normalized query and
 * effective result count, scoped to this instance only. Failures, malformed
 * responses and aborted calls are never cached.
 */
export class SearchRunPolicy {
  private readonly completed = new Map<string, DeepSeekSearchResult>();
  private readonly inFlight = new Map<string, Promise<DeepSeekSearchResult>>();
  private readonly stats: SearchRunStats;

  constructor(
    private readonly operationLimit: number,
    private readonly originalQuestion?: string,
  ) {
    this.stats = {
      operationLimit,
      operationsStarted: 0,
      operationsSucceeded: 0,
      duplicateHits: 0,
      inFlightHits: 0,
      exhausted: false,
    };
  }

  /** Snapshot of the run's operation accounting. Query-free and secret-free. */
  getStats(): SearchRunStats {
    return { ...this.stats };
  }

  /** True only when this exact normalized query and effective count would
   * reuse a completed or in-flight request. Used for progress display only. */
  hasSeen(query: string, count?: number): boolean {
    const { key } = requestIdentity(query, count);
    return this.completed.has(key) || this.inFlight.has(key);
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<PolicySearchOutput> {
    signal?.throwIfAborted();
    const parsed = webSearchInputSchema.parse(input);
    const { query, key } = requestIdentity(parsed.query, parsed.count);

    const completed = this.completed.get(key);
    if (completed) {
      signal?.throwIfAborted();
      this.stats.duplicateHits += 1;
      return { ...completed, note: REUSE_NOTE };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.stats.inFlightHits += 1;
      const result = await waitForInFlight(pending, signal);
      signal?.throwIfAborted();
      return { ...result, note: IN_FLIGHT_NOTE };
    }

    if (this.stats.operationsStarted >= this.operationLimit) {
      signal?.throwIfAborted();
      this.stats.exhausted = true;
      return { results: [], note: exhaustedNote(this.operationLimit) };
    }
    this.stats.operationsStarted += 1;

    const promise = deepseekWebSearch(
      { query, count: parsed.count },
      signal,
      { originalQuestion: this.originalQuestion },
    );
    this.inFlight.set(key, promise);
    try {
      const result = await promise;
      signal?.throwIfAborted();
      this.stats.operationsSucceeded += 1;
      this.completed.set(key, result);
      return {
        ...result,
        note: result.results.length === 0 ? NO_RESULTS_NOTE : undefined,
      };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
