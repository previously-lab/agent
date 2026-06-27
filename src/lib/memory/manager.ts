import matter from "gray-matter";
import type { MemoryNode, MemoryIndex, NodeMeta, NodeFilter } from "./types";

// In-memory cache of the index (loaded from GitHub at startup, refreshed on demand)
let indexCache: MemoryIndex | null = null;

/**
 * Parse a memory node Markdown string into structured data.
 */
export function parseNode(raw: string): MemoryNode {
  const { data, content } = matter(raw);
  return {
    id: data.id ?? "",
    type: data.type ?? "concept",
    domain: data.domain ?? "general",
    tags: data.tags ?? [],
    related: data.related ?? [],
    backlinks: data.backlinks ?? [],
    priority: data.priority ?? 5,
    access_count: data.access_count ?? 0,
    last_accessed: data.last_accessed ?? new Date().toISOString().split("T")[0],
    recall_conditions: data.recall_conditions ?? [],
    status: data.status ?? "active",
    superseded_by: data.superseded_by,
    title: data.title ?? "",
    content: content.trim(),
  };
}

/**
 * Extract node metadata (without full content) for the index.
 */
export function extractMeta(node: MemoryNode, filePath: string): NodeMeta {
  return {
    path: filePath,
    type: node.type,
    tags: node.tags,
    links: node.related,
    backlinks: node.backlinks,
    priority: node.priority,
    access_count: node.access_count,
    last_accessed: node.last_accessed,
    status: node.status,
    superseded_by: node.superseded_by,
  };
}

/**
 * Set the in-memory index (e.g. after loading from GitHub).
 */
export function setIndex(index: MemoryIndex): void {
  indexCache = index;
}

/**
 * Get the current index, optionally loading from a JSON source.
 */
export function getIndex(): MemoryIndex {
  if (!indexCache) {
    return { nodes: {} };
  }
  return indexCache;
}

/**
 * List node metadata matching the given filter.
 */
export function listNodes(filter: NodeFilter = {}): NodeMeta[] {
  const index = getIndex();
  let nodes = Object.entries(index.nodes).map(([id, meta]) => ({
    ...meta,
    id,
  })) as (NodeMeta & { id: string })[];

  // Filter by type
  if (filter.types && filter.types.length > 0) {
    nodes = nodes.filter((n) => filter.types!.includes(n.type));
  }

  // Filter by tags (match any)
  if (filter.tags && filter.tags.length > 0) {
    nodes = nodes.filter((n) =>
      n.tags.some((t) => filter.tags!.includes(t))
    );
  }

  // Filter by status
  if (filter.status) {
    nodes = nodes.filter((n) => n.status === filter.status);
  }

  // Exclude deprecated nodes (unless explicitly filtered for)
  if (!filter.status || filter.status !== "deprecated") {
    nodes = nodes.filter((n) => n.status !== "deprecated");
  }

  // Apply limit
  if (filter.limit && filter.limit > 0) {
    nodes = nodes.slice(0, filter.limit);
  }

  return nodes;
}

/**
 * Get metadata for a single node by ID.
 */
export function getNodeMeta(id: string): NodeMeta | null {
  const index = getIndex();
  const meta = index.nodes[id];
  if (!meta) return null;
  if (meta.status === "deprecated" && !meta.superseded_by) return null;
  return meta;
}

/**
 * Build an index from a directory of Markdown files.
 * Takes raw file contents keyed by path.
 */
export function buildIndex(files: Record<string, string>): MemoryIndex {
  const nodes: Record<string, NodeMeta> = {};

  for (const [path, raw] of Object.entries(files)) {
    try {
      const node = parseNode(raw);
      if (!node.id) continue; // skip invalid nodes
      nodes[node.id] = extractMeta(node, path);
    } catch {
      // skip unparseable files
    }
  }

  const index = { nodes };
  indexCache = index;
  return index;
}

/**
 * Check if a node satisfies a recall condition predicate.
 */
export function evaluatePredicate(
  condition: string,
  query: string,
  taskType: string
): boolean {
  const lowerCondition = condition.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Check "query contains X or Y"
  const containsMatch = lowerCondition.match(
    /query\s+contains\s+'([^']+)'/g
  );
  if (containsMatch) {
    return containsMatch.some((m) => {
      const term = m.match(/'([^']+)'/)?.[1] ?? "";
      return lowerQuery.includes(term.toLowerCase());
    });
  }

  // Check "task_type == X"
  const taskMatch = lowerCondition.match(
    /task_type\s*==\s*'([^']+)'/g
  );
  if (taskMatch) {
    return taskMatch.some((m) => {
      const type = m.match(/'([^']+)'/)?.[1] ?? "";
      return taskType === type;
    });
  }

  return true; // default: pass
}

/**
 * Clear in-memory cache (useful for testing).
 */
export function clearCache(): void {
  indexCache = null;
}
