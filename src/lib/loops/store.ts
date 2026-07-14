/**
 * Loop run persistence — serialize a LoopRun to markdown and write it to
 * `memory/loops/...` after every step.
 *
 * Mirrors the episodic subsystem's local-fs-vs-GitHub switch (gated on
 * GITHUB_TOKEN, see src/lib/episodic/manager.ts) so it behaves identically in
 * local dev (writes to disk) and production (writes to the repo). The guards
 * mirror the pure predicates in src/lib/loop/engine.ts.
 */
import matter from "gray-matter";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { writeFileLocal } from "@/lib/tools/local-fs";
import type { LoopRun, LoopStep } from "./types";

// ─── Storage backend switch (mirrors src/lib/episodic/manager.ts) ──────────

const USE_GITHUB = !!process.env.GITHUB_TOKEN;

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

/**
 * Write/update the loop record file. Idempotent: writeFile resolves the
 * existing blob SHA and updates in place, so calling this after every step is
 * safe. Path validation (memory/ whitelist) happens inside the tools layer.
 */
export async function writeLoopFile(
  path: string,
  content: string
): Promise<void> {
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    await writeFileGitHub(path, content, repo, owner, `Update loop ${path}`);
    return;
  }
  await writeFileLocal(path, content);
}

// ─── Serialization ─────────────────────────────────────────────────────────

/** Render a LoopRun as YAML frontmatter + a Markdown step log. */
export function serializeLoop(run: LoopRun): string {
  const frontmatter: Record<string, unknown> = {
    loop_id: run.loopId,
    goal: run.goal,
    status: run.status,
    started_at: run.startedAt,
    updated_at: run.updatedAt,
    iterations: run.iterations,
    max_iterations: run.maxIterations,
    tags: run.tags,
  };
  if (run.sliceOrigin) frontmatter.slice_origin = run.sliceOrigin;
  if (run.lastError) frontmatter.last_error = run.lastError;

  const body = [
    `# Loop: ${run.goal}`,
    "",
    `**Status**: ${run.status} · **Step** ${run.iterations}/${run.maxIterations}`,
    "",
    "## Steps",
    "",
    run.steps.length === 0
      ? "_No steps yet._"
      : run.steps.map(renderStep).join("\n"),
  ].join("\n");

  return matter.stringify(body, frontmatter);
}

function renderStep(s: LoopStep): string {
  return [
    `### Step ${s.step} — ${s.time}`,
    "",
    `**Action**: ${s.action}`,
    "",
    s.result,
    "",
  ].join("\n");
}
