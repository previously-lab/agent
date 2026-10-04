/**
 * Backend-aware slice enumeration — the LIVE-ENUMERATION read path that
 * replaced the retired projections (v0.19 §A.2.4: the timeline index and
 * monthly `_index.json` weaves are gone; readers enumerate the tree instead).
 * Consumers: the actions.ts read surface, the home recap, and the turn
 * path's stale-active-slice scan (steps.ts).
 *
 * Returns the *actual* set of slice relative paths ("YYYY/MM/DD/HHMM") that
 * exist on disk / in the repo.
 *
 * - GitHub: recursive Git Trees API — ONE call returns every path under the
 *   repo, so enumeration never costs N directory round-trips.
 * - Local / demo: recursive walk through the existing fsListFiles layer (which
 *   routes to local-fs or demo-fs).
 */
import { getOctokit } from "@/lib/github/client";
import { getRepoConfig } from "@/lib/capabilities";
import { getDefaultBranch } from "@/lib/tools/batch-write";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { fsListFiles } from "../io-helpers";
import { RECORDS_ROOT, LEGACY_SLICES_ROOT } from "../paths";

/** A slice relative path segment: "2026/08/11/1115". */
export const SLICE_PATH_RE = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * Enumerate all slice dirs under BOTH roots (v0.19 R2 dual-root): the new
 * records root and the legacy slices root, merged and deduped — the live
 * enumeration spans the root move.
 */
export async function enumerateSliceIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const root of [RECORDS_ROOT, LEGACY_SLICES_ROOT]) {
    const list =
      resolveDataSource() === "github"
        ? await enumerateGithubTree(root)
        : await enumerateViaList(root);
    for (const id of list) ids.add(id);
  }
  return [...ids];
}

async function enumerateGithubTree(root: string): Promise<string[]> {
  const { owner, repo } = getRepoConfig();
  const octokit = getOctokit();
  // The repo's default branch, not a hardcoded "main" (see batch-write.ts).
  const branch = await getDefaultBranch();
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref.object.sha,
    recursive: "1",
  });

  const ids: string[] = [];
  const prefix = `${root}/`;
  for (const item of tree.tree ?? []) {
    if (item.type !== "tree") continue;
    const p = item.path ?? "";
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (SLICE_PATH_RE.test(rel)) ids.push(rel);
  }
  return ids;
}

/** List a dir, returning [] when it doesn't exist (missing year/month/day). */
async function safeList(path: string): Promise<
  Array<{ name: string; type: "file" | "dir" }>
> {
  try {
    return await fsListFiles(path);
  } catch {
    return [];
  }
}

async function enumerateViaList(root: string): Promise<string[]> {
  const ids: string[] = [];
  const isYear = (n: string) => /^\d{4}$/.test(n);
  const isPair = (n: string) => /^\d{2}$/.test(n);

  const years = await safeList(root);
  for (const y of years.filter((e) => e.type === "dir" && isYear(e.name))) {
    const months = await safeList(`${root}/${y.name}`);
    for (const mo of months.filter((e) => e.type === "dir" && isPair(e.name))) {
      const days = await safeList(`${root}/${y.name}/${mo.name}`);
      for (const d of days.filter((e) => e.type === "dir" && isPair(e.name))) {
        const slices = await safeList(`${root}/${y.name}/${mo.name}/${d.name}`);
        for (const s of slices.filter((e) => e.type === "dir" && /^\d{4}$/.test(e.name))) {
          ids.push(`${y.name}/${mo.name}/${d.name}/${s.name}`);
        }
      }
    }
  }
  return ids;
}
