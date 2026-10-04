/**
 * Run-shared helpers for the background side (v0.21 §5) — the model, the
 * listTree manifest and the card-evolution readers a background run needs
 * because it carries neither a ToolContext nor a TurnInput.
 *
 * WHY THIS MODULE EXISTS: the Workflow plugin bundles a workflow file's
 * import graph into the deterministic sandbox, and a **step module may export
 * ONLY step functions** — exporting a plain function from one pulls that
 * function's whole dependency graph into the sandbox, which fails the build
 * with `node-js-module-in-workflow` (verified empirically: adding just three
 * `export` keywords to `background-steps.ts` broke the dev server; see
 * node_modules/workflow/docs/errors/node-js-module-in-workflow).
 *
 * So these three helpers live here, reached only through steps: `hq-steps.ts`
 * → `background-steps.ts` (private use) and the HQ agent's tools.
 */
import {
  slicePartPathCandidates,
  type SlicePart,
} from "@/lib/episodic";
import { parseSliceId, parseTurns } from "@/lib/episodic/turn-parser";
import { fsListFiles, fsReadFile } from "@/lib/episodic/io-helpers";
import type { CaseWriterManifest } from "@/lib/episodic/flash/librarian";
import { getModel, getDefaultModelId } from "@/lib/models/registry";
import type { CardEvolutionReaders } from "@/app/api/evolution/run-card-evolution";

/** The deployment's default model — a background run has no turn input. */
export function backgroundModel() {
  return getModel(getDefaultModelId());
}

/**
 * The listTree manifest for a writer pass — the same mechanical walk the
 * reply segment's listTree tool does (memory/, config/ filtered out,
 * records/ collapsed to slice dirs), rebuilt here on the env-driven io layer
 * so a background run needs no ToolContext.
 */
export async function buildRunManifest(): Promise<CaseWriterManifest> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fsListFiles>>;
    try {
      entries = await fsListFiles(dir);
    } catch {
      return; // missing dir — a fresh memory root, fine
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.type === "dir") {
        await walk(p);
      } else if (p.startsWith("memory/") && !p.startsWith("memory/config/")) {
        paths.push(p.slice("memory/".length));
      }
    }
  };
  await walk("memory");

  const tree: Record<string, string[]> = {};
  for (const rel of paths) {
    const top = rel.split("/")[0] ?? rel;
    // records/YYYY/MM/DD/HHMM/<file> → the slice dir is the record's identity.
    const key =
      top === "records" ? rel.split("/").slice(0, 5).join("/") : rel;
    const list = (tree[top] ??= []);
    if (!list.includes(key)) list.push(key);
  }
  for (const list of Object.values(tree)) list.sort();
  return { truncated: false, tree };
}

/**
 * Card-evolution readers for a background run — the same dual-root probes
 * the turn path's buildCardReaders does, but on the env-driven io layer
 * (a background run carries no TurnInput backend flags).
 */
export function buildRunCardReaders(): CardEvolutionReaders {
  const readDual = async (sliceId: string, part: SlicePart): Promise<string> => {
    const [primary, fallback] = slicePartPathCandidates(sliceId, part);
    try {
      return await fsReadFile(primary);
    } catch {
      return fsReadFile(fallback);
    }
  };
  return {
    readSlice: async (sid, range) => {
      if (!parseSliceId(sid)) return `ERROR: Invalid slice ID.`;
      const raw = await readDual(sid, "core");
      if (range && range.type === "last") {
        const { turns } = parseTurns(raw);
        const n = range.count ?? 3;
        return turns
          .slice(-n)
          .map((t) => `${t.header}\n${t.content}`)
          .join("\n");
      }
      return raw;
    },
    readAgentTimeline: async (sid) => {
      if (!parseSliceId(sid)) return `(invalid slice: ${sid})`;
      return readDual(sid, "agent").catch(() => `(agent.md not found: ${sid})`);
    },
    readPreviously: async (sid) => {
      if (!parseSliceId(sid)) return `(invalid slice: ${sid})`;
      return readDual(sid, "previously").catch(
        () => `(previously not found: ${sid})`,
      );
    },
  };
}
