/**
 * Emergency save endpoint for beforeunload — called via navigator.sendBeacon.
 *
 * Appends pending turns to the active time slice markdown file, persisting
 * in-flight conversation state before the page is torn down.
 *
 * This is fire-and-forget from the client's perspective: the browser does not
 * wait for the response. Errors are logged but not surfaced to the user.
 */
import { writeFile } from "@/lib/tools";
import { writeFileLocal } from "@/lib/tools/local-fs";
import { fsReadFile } from "@/lib/episodic/io-helpers";
import { sliceIdToFilePath, sliceIdToAgentPath } from "@/lib/episodic/manager";
import { parseSliceId } from "@/lib/episodic/turn-parser";
import { isProtectedSystemPath } from "@/lib/whitelist";
import { guardRequest } from "@/lib/security/origin-guard";
import { z } from "zod";
import { getRepoConfig, isDemo } from "@/lib/capabilities";
// The WRITE still switches backend by hand, and that is deliberate for now:
// demo never reaches it (the route returns early), so the two branches below
// are the only reachable ones, and `fsWriteFile` would replace the specific
// commit message ("Flush turns for slice <id>") with a generic one. The READ
// above was the actual defect — it was reading through a cache — and is fixed.
import { resolveDataSource } from "@/lib/data-source/resolve";

// ─── Types ───────────────────────────────────────────────────────────────

const flushRequestSchema = z.object({
  // Strict slice id (YYYY-MM-DD-HHMM) — this value is interpolated into a
  // file path, so a loose string would be a path-traversal hole.
  sliceId: z
    .string()
    .refine((v) => parseSliceId(v) !== null, {
      message: "sliceId must be in YYYY-MM-DD-HHMM format",
    }),
  turns: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        content: z.string().max(100_000),
        timestamp: z.string().max(64),
      })
    )
    .min(1)
    .max(50),
});

type FlushRequest = z.infer<typeof flushRequestSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Count existing `## Turn N — …` headers in a markdown body so we know
 * where to resume numbering.
 */
function countExistingTurns(body: string): number {
  const matches = body.match(/^## Turn \d+ —/gm);
  return matches ? matches.length : 0;
}

/**
 * Format a single turn into its markdown block.
 */
function formatTurnBlock(
  turn: FlushRequest["turns"][number],
  index: number
): string {
  return `## Turn ${index} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`;
}

/**
 * Build a minimal frontmatter block for a brand-new slice file so the
 * resulting markdown is valid and parseable by the episodic manager.
 */
function buildFreshFrontmatter(sliceId: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `slice_id: "${sliceId}"`,
    'focus: ""',
    "status: active",
    `start: "${now}"`,
    "timezone: UTC",
    'summary: ""',
    "open_loops: []",
    "decisions: []",
    "tags: []",
    "related_slices: []",
    "---",
  ].join("\n");
}

// ─── Route handler ───────────────────────────────────────────────────────

export async function POST(request: Request) {
  const blocked = guardRequest(request);
  if (blocked) return blocked;
  try {
    // Demo mode: flush writes are not persisted — the beforeunload save is
    // irrelevant without a writable backend. Return success so the client
    // doesn't retry or error.
    if (isDemo()) {
      return Response.json({ success: true, demo: true });
    }

    const parsed = flushRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    const { sliceId, turns } = parsed.data;

    // Compute the slice file path (matching getSlicePath in the episodic manager)
    const slicePath = sliceIdToFilePath(sliceId);

    // ── Write-target constraint (defense in depth) ─────────────────────
    // This endpoint may only ever touch the target slice's own
    // timeline/core.md (or timeline/agent.md). Two independent layers:
    //  1. explicit allow-set derived from the validated sliceId, and
    //  2. isProtectedSystemPath — the write must land inside the
    //     system-managed episodic zone that generic write tools refuse.
    // The strict sliceId validation above already makes traversal
    // impossible; these checks guard against future refactors of the path
    // helpers silently widening what flush can overwrite.
    const allowedWriteTargets = new Set([
      sliceIdToFilePath(sliceId),
      sliceIdToAgentPath(sliceId),
    ]);
    if (!allowedWriteTargets.has(slicePath) || !isProtectedSystemPath(slicePath)) {
      console.error("[episodic/flush] Refused write target:", slicePath);
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    // ── Read the existing slice body (if any) ──────────────────────────
    // FRESH, and through the converged helper. This is the one read in the app
    // where a cached copy is a data-loss bug rather than a stale pixel: the
    // result is APPENDED to and written back, so a base that is missing turns
    // writes a file that is missing them too — permanently. And the window is
    // real: `memory/episodic/slices/**` carries a 24-hour TTL, and this route
    // is the `beforeunload` emergency path, which by construction runs in a
    // request context that may never have seen the write-side tag
    // invalidation.
    //
    // It was also hand-rolling the backend switch (`github ? readFile :
    // readFileLocal`) with no demo branch, so a demo session read the local
    // filesystem instead of the dataset. `fsReadFile` is the one place that
    // question is answered.
    let existingContent = "";
    try {
      existingContent = await fsReadFile(slicePath, undefined, { fresh: true });
    } catch {
      // File doesn't exist yet — we will create it from scratch below.
    }

    // ── Build the new turn blocks ──────────────────────────────────────
    const startingIndex = countExistingTurns(existingContent);
    const newTurnBlocks = turns
      .map((turn, i) => formatTurnBlock(turn, startingIndex + i + 1))
      .join("\n\n");

    // ── Assemble the full document ─────────────────────────────────────
    let newContent: string;
    if (existingContent.trim()) {
      // Append to existing file
      newContent = existingContent.trimEnd() + "\n\n" + newTurnBlocks;
    } else {
      // Create a fresh file with minimal frontmatter
      newContent = buildFreshFrontmatter(sliceId) + "\n\n" + newTurnBlocks;
    }

    // ── Persist ────────────────────────────────────────────────────────
    if (resolveDataSource() === "github") {
      const { owner, repo } = getRepoConfig();
      await writeFile(slicePath, newContent, repo, owner, `Flush turns for slice ${sliceId}`);
    } else {
      await writeFileLocal(slicePath, newContent);
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("[episodic/flush] Persist failed:", error);
    return Response.json(
      { error: "Internal error" },
      { status: 500 }
    );
  }
}
