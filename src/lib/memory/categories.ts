/**
 * The facade's category vocabulary (v0.36 §1) — a zero-dependency leaf module.
 *
 * Split out of facade.ts so that tools.ts (reachable from the "use workflow"
 * bundle, which rejects gray-matter → node:* transitive imports) can bind the
 * category enum into its zod schemas without pulling the facade's parser
 * dependencies into the workflow bundle.
 */

export const RECALL_CATEGORIES = [
  "events",
  "people",
  "things",
  "tasks",
  "research",
  "self",
  "timeline",
  "records",
  "places",
  "orgs",
] as const;

export type RecallCategory = (typeof RECALL_CATEGORIES)[number];

export function isRecallCategory(s: string): s is RecallCategory {
  return (RECALL_CATEGORIES as readonly string[]).includes(s);
}
