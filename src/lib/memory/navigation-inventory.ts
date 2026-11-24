// Server storage adapter; keep the tool schemas and projection in navigation.ts.
import { getDemoPersona, listFilesDemo } from "@/lib/demo/demo-fs";
import { isValidCaseName } from "@/lib/docs/case-naming";
import { CASE_CATEGORIES, isCaseCategory, MEMORY_ROOT_DIR } from "@/lib/docs/paths";
import { walkPathsLocal } from "@/lib/tools/local-fs";
import { getRepoTree } from "@/lib/tools/readFile";

type NavigationSource =
  | { kind: "local" }
  | { kind: "demo" }
  | { kind: "github"; repo: string; owner: string };

const LOCAL_WALK_OPTIONS = { maxDepth: 2, requireRealRoot: true };

/**
 * Existing canonical categories only. The optional scope selects a fixed
 * category root; no model-chosen case/file path reaches storage.
 */
export async function loadMemoryNavigationPaths(source: NavigationSource, scope?: string): Promise<string[]> {
  if (scope !== undefined && !isCaseCategory(scope)) throw new Error("Invalid memory navigation category");
  const roots = (scope === undefined ? CASE_CATEGORIES : [scope])
    .map((category) => `${MEMORY_ROOT_DIR}/${category}`);
  const paths: string[] = [];

  if (source.kind === "github") {
    const tree = await getRepoTree(source.repo, source.owner);
    if (tree.truncated) throw new Error("Memory navigation tree is incomplete");
    const rootSet = new Set(roots);
    for (const entry of tree.entries) {
      if (entry.type !== "blob") continue;
      const parts = entry.path.split("/");
      if ((parts.length === 3 || parts.length === 4) && rootSet.has(parts.slice(0, 2).join("/"))) {
        paths.push(entry.path);
      }
    }
  } else if (source.kind === "local") {
    for (const root of roots) {
      const files = await walkPathsLocal(root, LOCAL_WALK_OPTIONS);
      for (const file of files) paths.push(file);
    }
  } else {
    // Capture once: concurrent calls selecting a different persona must not
    // mix category listings from two personas.
    const persona = getDemoPersona();
    for (const root of roots) {
      const entries = await listFilesDemo(root, persona);
      const folders = new Set<string>();
      for (const entry of entries) {
        if (entry.type === "file" && root === "memory/self" && entry.name === "agenda.md") {
          paths.push(`${root}/agenda.md`);
        } else if (entry.type === "dir" && isSafeDemoCase(entry.name)) {
          folders.add(entry.name);
        }
      }
      for (const folder of folders) {
        const directory = `${root}/${folder}`;
        const files = await listFilesDemo(directory, persona);
        for (const file of files) {
          if (file.type === "file" && !/[/\\]/.test(file.name)) paths.push(`${directory}/${file.name}`);
        }
      }
    }
  }
  return paths;
}

/** Demo listings may come from a manifest. Never trust their returned paths. */
function isSafeDemoCase(name: string): boolean {
  return isValidCaseName(name) && !name.startsWith(".") && !/[#?\p{Cc}\p{Cf}]/u.test(name) &&
    !/[/\\]/.test(name.normalize("NFKC"));
}
