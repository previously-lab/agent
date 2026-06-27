import type { NodeMeta } from "./types";
import { evaluatePredicate } from "./manager";

/**
 * Score a memory node for relevance to a query.
 * Pure function — no side effects, no I/O.
 *
 * Formula:
 *   (base + relevance + graph_bonus + freq_bonus) × time_decay
 *
 * Returns 0 if recall conditions are not met.
 */
export function scoreNode(
  node: NodeMeta,
  query: string,
  taskType: string,
  alreadySelected: Set<string>,
  now: Date = new Date()
): number {
  // Skip deprecated nodes
  if (node.status === "deprecated") return 0;

  // 1. Check recall conditions (if defined on the node metadata)
  // Note: full recall_conditions are in the .md file frontmatter,
  // index.json has a simplified version. For scoring we check tags.
  // Full condition evaluation happens when loading the full node.

  // 2. Base score = explicit priority (1-10)
  let score = node.priority;

  // 3. Keyword relevance bonus
  const lowerQuery = query.toLowerCase();
  for (const tag of node.tags) {
    if (lowerQuery.includes(tag.toLowerCase())) {
      score += 5;
    }
  }

  // 4. Graph distance bonus: linked nodes that are already selected
  let graphBonus = 0;
  for (const link of node.links) {
    if (alreadySelected.has(link)) {
      graphBonus += 2;
    }
  }
  score += graphBonus;

  // 5. Frequency bonus: nodes accessed more often get a boost (capped at +3)
  const freqBonus = Math.min(node.access_count * 0.3, 3);
  score += freqBonus;

  // 6. Time decay: 10% per week since last access
  const lastAccessed = new Date(node.last_accessed);
  const daysSinceAccess =
    (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
  const decay = Math.pow(0.9, daysSinceAccess / 7);

  return score * decay;
}

/**
 * Score and rank nodes, returning the top N within the limit.
 */
export function rankNodes(
  nodes: NodeMeta[],
  query: string,
  taskType: string,
  limit: number,
  alreadySelected: Set<string> = new Set()
): NodeMeta[] {
  const scored = nodes
    .map((node) => ({
      node,
      score: scoreNode(node, query, taskType, alreadySelected),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  // Select top N, update alreadySelected as we go (for graph bonus)
  const selected: NodeMeta[] = [];
  const selectedSet = new Set(alreadySelected);

  for (const { node } of scored) {
    if (selected.length >= limit) break;
    selected.push(node);
    selectedSet.add(node.path);
  }

  return selected;
}
