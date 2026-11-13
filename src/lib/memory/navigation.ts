/**
 * Read-only navigation over the existing semantic memory layout. The input
 * inventory belongs to the storage adapter; a model-supplied path never
 * becomes a storage call or an unrestricted filename.
 */
import { z } from "zod";
import { isValidCaseName, parsePieceFileName } from "@/lib/docs/case-naming";
import { CASE_CATEGORIES, isCaseCategory } from "@/lib/docs/paths";
import { navigationNameScore } from "./name-match";

const PAGE_MAX = 30;
const DEFAULT_PAGE_SIZE = 20;
const pathInput = z.string().max(512);
const page = {
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).optional(),
};

export const recallListInputSchema = z.object({
  path: pathInput.optional().describe("Semantic directory, e.g. people or orgs/AirJelly. Omit for categories."),
  ...page,
}).strict();

export const recallPathFindInputSchema = z.object({
  name: z.string().trim().min(1).max(512).describe("A name or a semantic path. Returns navigation candidates, not document contents."),
  category: z.enum([...CASE_CATEGORIES, "records", "timeline"] as const).optional(),
  under: pathInput.optional().describe("Optional semantic category or case directory to search within."),
  ...page,
}).strict();

export type RecallListInput = z.infer<typeof recallListInputSchema>;
export type RecallPathFindInput = z.infer<typeof recallPathFindInputSchema>;

export interface DirectoryEntry {
  kind: "directory" | "document";
  /** Relative to the semantic memory root. Not a storage filename. */
  path: string;
  /** Use with recallRead (or readCase in reflection), when present. */
  ref?: string;
  name: string;
  score?: number;
}

export type DirectoryResult =
  | { kind: "entries"; entries: DirectoryEntry[]; total: number; nextOffset?: number }
  | { kind: "not_found" | "invalid_scope"; note: string };

const INVALID_PATH_NOTE = "Use a semantic memory category or case directory, such as people or orgs/AirJelly.";
const NOT_FOUND_NOTE = "The requested directory was not found in this memory listing.";
// Match the reserved shard names in docs/history-archive.ts without importing
// its Node and Markdown dependencies into the workflow tool schema graph.
const HISTORY_SHARD = /^\d{4}-\d{2}-\d{2}-history-v1-(index|current)-[a-f0-9]{16}-\d{4,}\.md$/i;

function validSegment(segment: string): boolean {
  return segment !== "" && segment === segment.trim() && !segment.startsWith(".") &&
    !segment.includes("..") && !/[\\#?\p{Cc}\p{Cf}]/u.test(segment) &&
    !/%[0-9a-f]{2}/i.test(segment) && !/[/\\]/.test(segment.normalize("NFKC"));
}

/** No normalization that can turn a rejected spelling into a different path. */
function parseDirectory(value = ""): string | null {
  if (!value) return "";
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = path.split("/");
  if (segments.length > 2 || !segments.every(validSegment) || !isCaseCategory(segments[0])) return null;
  return segments.length === 1 || isValidCaseName(segments[1]) ? path : null;
}

function documentEntry(path: string, ref: string, name: string): DirectoryEntry {
  return { kind: "document", path, ref, name };
}

/** A one-time projection for this call; it stores nothing beyond the inventory. */
function project(paths: readonly string[]): Map<string, DirectoryEntry> {
  const entries = new Map<string, DirectoryEntry>(CASE_CATEGORIES.map((category) => [
    category, { kind: "directory", path: category, name: category },
  ]));
  const caseIndexes = new Set<string>();
  const cases = new Set<string>();
  const currents = new Set<string>();
  for (const storagePath of paths) {
    const [root, category, caseName, file, ...rest] = storagePath.split("/");
    if (root !== "memory" || !isCaseCategory(category) || rest.length) continue;
    if (category === "self" && caseName === "agenda.md" && file === undefined) {
      entries.set("self/agenda.md", documentEntry("self/agenda.md", "self/agenda", "agenda.md"));
      continue;
    }
    if (!caseName || !file || !validSegment(caseName) || !isValidCaseName(caseName) ||
        !validSegment(file) || HISTORY_SHARD.test(file)) continue;
    const casePath = `${category}/${caseName}`;
    const path = `${casePath}/${file}`;
    if (file === "index.md") {
      // recallRead treats self/agenda as a reserved bare document.
      if (casePath === "self/agenda" || caseName.endsWith(".md")) continue;
      entries.set(path, documentEntry(path, casePath, file));
      caseIndexes.add(casePath);
    } else if (file === "profile.md" && casePath === "people/user") {
      entries.set(path, documentEntry(path, "people/user/profile", file));
    } else if (parsePieceFileName(file)) {
      entries.set(path, documentEntry(path, path.slice(0, -3), file));
    } else {
      if (file === "_current.md") currents.add(casePath);
      continue;
    }
    cases.add(casePath);
  }
  for (const path of cases) {
    const name = path.slice(path.indexOf("/") + 1);
    entries.set(path, { kind: "directory", path, name, ...(caseIndexes.has(path) ? { ref: path } : {}) });
  }
  for (const parent of currents) {
    // Current understanding is read together with the existing case index.
    const path = `${parent}/_current.md`;
    if (caseIndexes.has(parent)) entries.set(path, documentEntry(path, parent, "_current.md"));
  }
  return entries;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function comparePath(a: DirectoryEntry, b: DirectoryEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function paginate(entries: DirectoryEntry[], input: { offset?: number; limit?: number }): DirectoryResult {
  const offset = input.offset ?? 0;
  const end = offset + (input.limit ?? DEFAULT_PAGE_SIZE);
  return {
    kind: "entries", entries: entries.slice(offset, end), total: entries.length,
    ...(end < entries.length ? { nextOffset: end } : {}),
  };
}

export function listMemoryDirectory(paths: readonly string[], input: RecallListInput): DirectoryResult {
  const parsed = recallListInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid_scope", note: INVALID_PATH_NOTE };
  const directory = parseDirectory(parsed.data.path);
  if (directory === null) return { kind: "invalid_scope", note: INVALID_PATH_NOTE };
  const inventory = project(paths);
  if (directory && inventory.get(directory)?.kind !== "directory") {
    return { kind: "not_found", note: NOT_FOUND_NOTE };
  }
  const children = [...inventory.values()].filter(({ path }) => parentOf(path) === directory);
  return paginate(children.sort((a, b) => a.kind === b.kind ? comparePath(a, b) : a.kind === "directory" ? -1 : 1), parsed.data);
}

function parseFindName(query: string): string | null {
  const name = query.endsWith("/") ? query.slice(0, -1) : query;
  const segments = name.split("/");
  if (!segments.every(validSegment)) return null;
  return segments.length === 1 || (segments.length <= 3 && isCaseCategory(segments[0])) ? name : null;
}

function findScore(entry: DirectoryEntry, query: string): number {
  if (query.includes("/")) {
    // A common category prefix is a scope, not similarity. Compare the
    // remaining path; explicit case/file queries must also match that depth.
    const [category, ...queryParts] = query.split("/");
    const [entryCategory, ...pathParts] = entry.path.split("/");
    if (category !== entryCategory) return 0;
    const refParts = entry.ref?.split("/").slice(1);
    const scorePath = (parts: string[] | undefined): number => {
      if (!parts || parts.length !== queryParts.length) return 0;
      const scores = parts.map((part, index) => navigationNameScore(part, queryParts[index]));
      return Math.min(...scores);
    };
    return Math.max(scorePath(pathParts), scorePath(refParts));
  }
  const stem = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
  const title = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(stem)?.[1];
  return Math.max(navigationNameScore(entry.name, query), navigationNameScore(stem, query),
    title ? navigationNameScore(title, query) : 0);
}

export function findMemoryPaths(paths: readonly string[], input: RecallPathFindInput): DirectoryResult {
  const parsed = recallPathFindInputSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid_scope", note: INVALID_PATH_NOTE };
  const { name, category, under } = parsed.data;
  const directory = parseDirectory(under);
  const query = parseFindName(name);
  if (directory === null || query === null || (category !== undefined && !isCaseCategory(category))) {
    return { kind: "invalid_scope", note: INVALID_PATH_NOTE };
  }
  const inventory = project(paths);
  if (directory && inventory.get(directory)?.kind !== "directory") {
    return { kind: "not_found", note: NOT_FOUND_NOTE };
  }
  const sorted = [...inventory.values()].flatMap((entry) => {
    if ((category && entry.path.split("/")[0] !== category) ||
        (directory && !entry.path.startsWith(`${directory}/`))) return [];
    const score = findScore(entry, query);
    return score > 0 ? [{ ...entry, score }] : [];
  }).sort((a, b) => b.score - a.score || comparePath(a, b));
  // The same case is readable through its overview/current pair. Keep the
  // best matching label only; an explicit matching filename can still win.
  const seen = new Set<string>();
  const distinct = sorted.filter((entry) => {
    const key = entry.ref ?? entry.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return paginate(distinct, parsed.data);
}
