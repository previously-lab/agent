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

const PATH_LIMIT = 50_000;
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
  function addPath(path: string) {
    // The local walker may stop at the bound. Treat a full inventory as
    // unavailable rather than present it as complete.
    if (paths.length + 1 >= PATH_LIMIT) throw new Error("Memory navigation inventory limit reached");
    paths.push(path);
  }

  if (source.kind === "github") {
    const tree = await getRepoTree(source.repo, source.owner);
    if (tree.truncated) throw new Error("Memory navigation tree is incomplete");
    const rootSet = new Set(roots);
    for (const entry of tree.entries) {
      if (entry.type !== "blob") continue;
      const parts = entry.path.split("/");
      if ((parts.length === 3 || parts.length === 4) && rootSet.has(parts.slice(0, 2).join("/"))) {
        addPath(entry.path);
      }
    }
  } else if (source.kind === "local") {
    for (const root of roots) {
      const files = await walkPathsLocal(root, PATH_LIMIT - paths.length, LOCAL_WALK_OPTIONS);
      for (const file of files) addPath(file);
    }
  } else {
    // Capture once: concurrent calls selecting a different persona must not
    // mix category listings from two personas.
    const persona = getDemoPersona();
    let visited = 0;
    function charge(count: number) {
      visited += count;
      if (visited >= PATH_LIMIT) throw new Error("Memory navigation inventory limit reached");
    }
    for (const root of roots) {
      const entries = await listFilesDemo(root, persona);
      charge(entries.length);
      const folders = new Set<string>();
      for (const entry of entries) {
        if (entry.type === "file" && root === "memory/self" && entry.name === "agenda.md") {
          addPath(`${root}/agenda.md`);
        } else if (entry.type === "dir" && isSafeDemoCase(entry.name)) {
          folders.add(entry.name);
        }
      }
      for (const folder of folders) {
        const directory = `${root}/${folder}`;
        const files = await listFilesDemo(directory, persona);
        charge(files.length);
        for (const file of files) {
          if (file.type === "file" && !/[/\\]/.test(file.name)) addPath(`${directory}/${file.name}`);
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
