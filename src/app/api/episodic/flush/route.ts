/**
 * Emergency save endpoint for beforeunload — called via navigator.sendBeacon.
 *
 * Appends pending turns to the active time slice markdown file, persisting
 * in-flight conversation state before the page is torn down.
 *
 * This is fire-and-forget from the client's perspective: the browser does not
 * wait for the response. Errors are logged but not surfaced to the user.
 */
import { readFile, writeFile } from "@/lib/tools";
import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";
import { sliceIdToFilePath } from "@/lib/episodic/manager";

// ─── Environment detection ───────────────────────────────────────────────

const USE_GITHUB = process.env.GITHUB_TOKEN != null;

function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

// ─── Types ───────────────────────────────────────────────────────────────

interface FlushRequest {
  sliceId: string;
  turns: Array<{ role: string; content: string; timestamp: string }>;
}

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
  try {
    const body = (await request.json()) as FlushRequest;
    const { sliceId, turns } = body;

    // Validate required fields
    if (!sliceId || typeof sliceId !== "string") {
      return Response.json(
        { error: "sliceId is required and must be a string" },
        { status: 400 }
      );
    }

    if (!turns || !Array.isArray(turns) || turns.length === 0) {
      return Response.json(
        { error: "turns must be a non-empty array" },
        { status: 400 }
      );
    }

    // Compute the slice file path (matching getSlicePath in the episodic manager)
    const slicePath = sliceIdToFilePath(sliceId);

    // ── Read the existing slice body (if any) ──────────────────────────
    let existingContent = "";
    try {
      if (USE_GITHUB) {
        const { owner, repo } = getRepoConfig();
        existingContent = await readFile(slicePath, repo, owner);
      } else {
        existingContent = await readFileLocal(slicePath);
      }
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
    if (USE_GITHUB) {
      const { owner, repo } = getRepoConfig();
      await writeFile(slicePath, newContent, repo, owner, `Flush turns for slice ${sliceId}`);
    } else {
      await writeFileLocal(slicePath, newContent);
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("[episodic/flush] Persist failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
