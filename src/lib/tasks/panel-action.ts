"use server";

/**
 * The task panel's read action (v0.11 streams). An ordinary "use server"
 * module — the ONLY entry the panel's client code calls. Reads are cached
 * for a short TTL so filter switches and load-more pages derive from ONE
 * canonical snapshot without re-hitting the data source; an explicit
 * `refresh: true` (panel open, Refresh button) bypasses the TTL and asks
 * `readTaskLedger` for a fresh authoritative read. No polling, no heartbeat,
 * no mutation — this module never writes the ledger.
 */
import { createHash } from "node:crypto";
import { nativeSourceScopeForDeployment } from "@/lib/chat/native-source-scope.server";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getDemoPersona } from "@/lib/demo/demo-fs";
import { readTaskLedger } from "./store";
import type { TaskLedgerReadResult } from "./contracts";
import {
  parseTaskPanelQuery,
  projectTaskLedgerRead,
  type TaskPanelResponse,
} from "./panel";

const PANEL_LEDGER_CACHE_TTL_MS = 20_000;
const PANEL_LEDGER_CACHE_MAX_SOURCES = 8;

interface PanelLedgerCacheEntry {
  readAt: number;
  snapshot: string;
  result: TaskLedgerReadResult;
}

const panelLedgerCache = new Map<string, PanelLedgerCacheEntry>();

function panelSourceKey(): string {
  const scope = nativeSourceScopeForDeployment();
  return resolveDataSource() === "demo"
    ? `${scope}:persona:${getDemoPersona()}`
    : scope;
}

function cachePanelEntry(key: string, entry: PanelLedgerCacheEntry): void {
  panelLedgerCache.delete(key);
  panelLedgerCache.set(key, entry);
  while (panelLedgerCache.size > PANEL_LEDGER_CACHE_MAX_SOURCES) {
    const oldest = panelLedgerCache.keys().next().value;
    if (oldest === undefined) break;
    panelLedgerCache.delete(oldest);
  }
}

/** One panel page. Offset pages must name the opaque snapshot they extend. */
export async function getTaskPanelPage(
  input: unknown,
): Promise<TaskPanelResponse> {
  const query = parseTaskPanelQuery(input);
  const raw = (input ?? {}) as Record<string, unknown>;
  const refresh = raw.refresh === true;
  const requestedSnapshot =
    typeof raw.snapshot === "string" ? raw.snapshot : null;
  const key = panelSourceKey();
  const cached = panelLedgerCache.get(key);
  let entry: PanelLedgerCacheEntry;
  if (
    refresh ||
    cached === undefined ||
    Date.now() - cached.readAt > PANEL_LEDGER_CACHE_TTL_MS
  ) {
    const result = await readTaskLedger(refresh ? { fresh: true } : {});
    entry = {
      readAt: Date.now(),
      // Different Vercel instances must agree on identical canonical state,
      // while a cold start must never reuse a token for changed task content.
      snapshot: result.status === "ready"
        ? createHash("sha256").update(key).update("\0")
          .update(JSON.stringify(result.ledger)).digest("hex")
        : "not-ready",
      result,
    };
  } else {
    entry = cached;
  }
  cachePanelEntry(key, entry);
  if (
    entry.result.status === "ready" &&
    query.offset > 0 &&
    requestedSnapshot !== entry.snapshot
  ) {
    return { status: "stale" };
  }
  return projectTaskLedgerRead(entry.result, query, entry.snapshot);
}
