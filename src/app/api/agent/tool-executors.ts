/**
 * Tool executors for the shared WorkflowAgent — standalone "use step" functions.
 *
 * Each executor is an independent durable step: automatically retried on
 * failure, persisted, and visible in the workflow dashboard. Context (repo,
 * owner, useGithub, sliceId / loop identity) flows through WorkflowAgent's
 * `toolsContext` mechanism rather than JavaScript closures, so it stays
 * serializable across workflow/step boundaries.
 *
 * Used by BOTH the chat turn workflow and the background loop workflow — the
 * tool definitions that bind these executors live in ./tools.ts.
 */

import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";
// Side effect: register the DeepSeek model class in the step runtime's
// serialization registry (see register-model-classes.ts for why).
import "./register-model-classes";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { listFiles } from "@/lib/tools/listFiles";
import {
  readFileLocal,
  listFilesLocal,
  writeFileLocal,
} from "@/lib/tools/local-fs";
import {
  readFileDemo,
  listFilesDemo,
  writeFileDemo,
} from "@/lib/demo/demo-fs";
import { isPathAllowed, isProtectedSystemPath } from "@/lib/whitelist";

import { searchViaFlash, type WebSearchResult } from "@/lib/search/flash-search";
import { startLoop } from "@/app/api/loops/start-loop";
import { readLoopRun, serializeLoop, writeLoopFile } from "@/lib/loops/store";
import { isAIConfigured, canWrite, DEPLOY_GUIDE_URL } from "@/lib/capabilities";
import type { LoopRun, LoopStep } from "@/lib/loops/types";

// ─── Shared tool contexts ────────────────────────────────────────────────

/**
 * Context each chat tool receives from WorkflowAgent's toolsContext mechanism.
 * Kept serializable so it survives workflow step boundaries.
 */
export interface ToolContext {
  /** GitHub repo name (or "local" when running without GITHUB_TOKEN). */
  repo: string;
  /** GitHub repo owner (or "local" when running without GITHUB_TOKEN). */
  owner: string;
  /** Whether GitHub token is configured. Off → local filesystem. */
  useGithub: boolean;
  /** Whether demo mode is active (remote benchmark data, read-only). */
  useDemo: boolean;
  /** The current time-slice id (for startLoop to record the link). */
  sliceId: string;
}

/**
 * Context the loop's checkpoint tool receives — the loop's own identity, so
 * loopReportExecute can do the read-append-write on the loop record file.
 */
export interface LoopToolContext {
  repo: string;
  owner: string;
  useGithub: boolean;
  loopId: string;
  goal: string;
  filePath: string;
  startedAt: string;
  sliceOrigin: string | null;
  tags: string[];
  maxIterations: number;
}

/** Shorthand for the options object each execute function receives. */
type ExecuteOpts<C> = {
  context: C;
};

// ─── Memory tool executors (chat + loop) ─────────────────────────────────

/**
 * Deterministic domain outcomes ("file not found", "access denied", …) must
 * reach the MODEL as tool results, not throw. A thrown error is treated as a
 * transient failure by the workflow runtime, which retries the step 3 more
 * times (with backoff) before bubbling — pure waste on errors that can never
 * succeed, and the agent never gets the chance to adapt. Anything not matched
 * here (network failures, GitHub 5xx) still throws and gets the retries.
 */
const DOMAIN_ERROR_RE =
  /^(File not found|Directory not found|Access denied)|is (a directory, not a file|not a regular file)|too large/;

function domainError(e: unknown): string | null {
  return e instanceof Error && DOMAIN_ERROR_RE.test(e.message)
    ? e.message
    : null;
}

export async function readMemoryExecute(
  { path }: { path: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<string> {
  "use step";
  try {
    if (ctx.useDemo) return await readFileDemo(path);
    return ctx.useGithub
      ? await readFile(path, ctx.repo, ctx.owner)
      : await readFileLocal(path);
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    const hint = msg.startsWith("File not found")
      ? " The file does not exist — do not retry this path. Use listMemory to see what actually exists, or write the file first."
      : "";
    return `ERROR: ${msg}.${hint}`;
  }
}

export async function listMemoryExecute(
  { path }: { path: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<Array<{ name: string; type: "file" | "dir"; path: string }> | { error: string }> {
  "use step";
  try {
    if (ctx.useDemo) return await listFilesDemo(path);
    return ctx.useGithub
      ? await listFiles(path, ctx.repo, ctx.owner)
      : await listFilesLocal(path);
  } catch (e) {
    const msg = domainError(e);
    if (msg === null) throw e;
    const hint = msg.startsWith("Directory not found")
      ? " The directory does not exist — do not retry this path."
      : "";
    return { error: `${msg}.${hint}` };
  }
}

export async function readIndexExecute(
  { year, month }: { year: number; month: number },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ exists: boolean; month: string; slices: unknown[] }> {
  "use step";
  const mm = String(month).padStart(2, "0");
  const path = `memory/episodic/slices/${year}/${mm}/_index.json`;
  try {
    const raw = ctx.useDemo
      ? await readFileDemo(path)
      : ctx.useGithub
        ? await readFile(path, ctx.repo, ctx.owner)
        : await readFileLocal(path);
    return JSON.parse(raw);
  } catch {
    return { exists: false, month: `${year}-${mm}`, slices: [] };
  }
}

export async function writeMemoryExecute(
  { path, content, reason }: { path: string; content: string; reason: string },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ ok: boolean; path?: string; created?: boolean; error?: string }> {
  "use step";
  if (!isPathAllowed(path) || isProtectedSystemPath(path)) {
    return {
      ok: false,
      error: `Write denied: "${path}" is outside the writable area or is system-managed.`,
    };
  }
  try {
    const res = ctx.useDemo
      ? await writeFileDemo(path, content)
      : ctx.useGithub
        ? await writeFile(path, content, ctx.repo, ctx.owner, `[agent] ${reason}`)
        : await writeFileLocal(path, content);
    return { ok: true, path: res.path, created: res.created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "write failed" };
  }
}

// ─── Chat-only executors ─────────────────────────────────────────────────

/**
 * webSearch — delegates to the Flash search adapter (see lib/search/). The
 * context is accepted for tool-set uniformity but unused: search needs no
 * repo identity. A missing API key is a deterministic config problem →
 * returned as data; transient search failures throw and get the step retries.
 */
export async function webSearchExecute(
  { query }: { query: string },
  _opts: ExecuteOpts<ToolContext>,
): Promise<WebSearchResult | { error: string }> {
  "use step";
  if (!isAIConfigured()) {
    return { error: "Web search is not configured (DEEPSEEK_API_KEY missing)." };
  }
  return searchViaFlash(query);
}

export async function updateUserProfileExecute(
  patch: {
    name?: string;
    pronouns?: string;
    timezone?: string;
    locale?: string;
    addressAs?: string;
    body?: string;
    reason: string;
  },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ ok: boolean; error?: string }> {
  "use step";

  // Build a belief line from the patch fields
  const parts: string[] = [];
  if (patch.name) parts.push(`自称 ${patch.name}`);
  if (patch.addressAs) parts.push(`可用 ${patch.addressAs} 称呼`);
  if (patch.pronouns) parts.push(`代词: ${patch.pronouns}`);
  if (patch.timezone) parts.push(`时区: ${patch.timezone}`);
  if (patch.locale) parts.push(`语言: ${patch.locale}`);
  if (patch.body) parts.push(patch.body);

  if (parts.length === 0) {
    return { ok: false, error: "No profile fields provided" };
  }

  const beliefText = parts.join("，");
  const evidenceSlice = ctx.sliceId.replace(/-/g, "/").replace(/^(\d{4})(\d{2})(\d{2})(\d{4})$/, "$1/$2/$3/$4");
  // sliceId is YYYY-MM-DD-HHMM → YYYY/MM/DD/HHMM for the citation

  try {
    // Read current previously.md
    const { readPreviously, writePreviously } =
      await import("@/lib/episodic/manager");
    const { applyBeliefUpdates } =
      await import("@/lib/episodic/maintenance");

    const current = await readPreviously(ctx.sliceId);
    if (!current.trim()) {
      return { ok: false, error: "No previously.md exists for this slice yet" };
    }

    const update = {
      action: "observe" as const,
      section: "User identity" as const,
      belief: beliefText,
      evidence_slice: evidenceSlice || ctx.sliceId,
      evidence_turn: "?",
    };

    const updated = applyBeliefUpdates(current, [update], ctx.sliceId);
    await writePreviously(ctx.sliceId, updated);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "write failed" };
  }
}

export async function startLoopExecute(
  { goal, tags }: { goal: string; tags?: string[] },
  { context: ctx }: ExecuteOpts<ToolContext>,
): Promise<{ ok: boolean; loopId?: string; runId?: string; filePath?: string; error?: string }> {
  "use step";

  // Demo mode: loops require a connected GitHub repo for write access.
  // The rejection is model-facing — the model reads it and explains the
  // deployment requirement to the user naturally in the conversation.
  if (!canWrite()) {
    return {
      ok: false,
      error:
        "The user is currently in demo mode (read-only preview data, no connected " +
        "GitHub repository). Background loops need a real repository to write " +
        "progress to memory/loops/. Tell the user they need to deploy their own " +
        "instance to unlock background loops. Setup guide: " + DEPLOY_GUIDE_URL,
    };
  }

  try {
    const started = await startLoop({
      goal,
      tags: tags ?? [],
      sliceId: ctx.sliceId,
    });
    // NOTE: the slice.loops / slice.tags back-reference is written by the chat
    // workflow's finalizeTurn step (which owns the slice by value) — not here.
    return {
      ok: true,
      loopId: started.loopId,
      runId: started.runId,
      filePath: started.filePath,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "failed to start loop",
    };
  }
}

// ─── Loop-only executor: the checkpoint tool ─────────────────────────────

/**
 * loopReport — the loop's checkpoint. Each call appends one LoopStep to the
 * loop's markdown record (read-append-write; the file is the accumulator, so
 * progress survives any crash/retry) and emits a `data-loop` progress chunk to
 * the run's writable for live watchers. Replaces the old per-iteration
 * persistLoop + streamLoopProgress pair.
 */
export async function loopReportExecute(
  { action, result, done }: { action: string; result: string; done: boolean },
  { context: ctx }: ExecuteOpts<LoopToolContext>,
): Promise<{ recorded: true; step: number; done: boolean }> {
  "use step";

  const existing = await readLoopRun(ctx.filePath);
  const priorSteps: LoopStep[] = existing?.steps ?? [];
  const step: LoopStep = {
    step: priorSteps.length + 1,
    action,
    result,
    time: new Date().toISOString(),
  };
  const steps = [...priorSteps, step];

  const run: LoopRun = {
    loopId: ctx.loopId,
    goal: ctx.goal,
    status: "running", // final status is stamped by the workflow's finalizeLoop
    startedAt: ctx.startedAt,
    updatedAt: new Date().toISOString(),
    sliceOrigin: ctx.sliceOrigin,
    tags: ctx.tags,
    iterations: steps.length,
    maxIterations: ctx.maxIterations,
    lastError: existing?.lastError ?? "",
    steps,
  };
  await writeLoopFile(ctx.filePath, serializeLoop(run));

  // Live progress chunk — best-effort: the memory-truth write above already
  // committed, so a stream failure must never fail the checkpoint.
  try {
    const writable = getWritable<UIMessageChunk>();
    const writer = writable.getWriter();
    await writer.write({
      type: "data-loop",
      id: `loop-${ctx.loopId}`,
      data: {
        loopId: ctx.loopId,
        goal: ctx.goal,
        status: "running",
        iteration: steps.length,
        latestStep: step,
        done: false,
      },
    } as UIMessageChunk);
    writer.releaseLock();
  } catch (err) {
    console.warn(
      `[Loop] progress chunk failed (loop=${ctx.loopId}):`,
      err instanceof Error ? err.message : err
    );
  }

  return { recorded: true, step: step.step, done };
}
