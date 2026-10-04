/**
 * Path constants for the evolution data layer (v1.0 design §2).
 *
 * Everything here is memory DATA under `memory/` — the mutable surface the
 * evolution loop owns. The sub-agent contracts (schemas, tools, step budgets)
 * stay in `src/`; these files are what the evolution agent may rewrite
 * (direction doc, per-agent playbooks) or append to (fitness store). Keeping
 * the paths in one module keeps every reader/writer byte-identical on where
 * the truth lives.
 */

/** The cross-slice user-portrait document (design §2.2). */
export const DIRECTION_PATH = "memory/evolution/direction.md";

/** Fitness events + mechanical signals store (design §2.5 / §2.6).
 *  LEGACY: the whole-file `fitness.json` — read-side fallback only (old
 *  repos may still have one; the reader merges it and never crashes on it). */
export const FITNESS_PATH = "memory/evolution/fitness.json";

/**
 * The directory-level append-only fitness store (v0.16 S0 / design §3.1):
 * ONE file per event/signal — `<ISO-ts>-<rand>.json` — distinguished by
 * shape (a `bucket` field = scored event, a `type` field = mechanical
 * signal). Concurrent writers never touch the same file, so a lost update
 * is structurally impossible; a successful evolution run settles the
 * generation by DELETING the spent files (no cross-generation bookkeeping).
 */
export const FITNESS_EVENTS_DIR = "memory/evolution/fitness/events";

/**
 * The per-slice direction-proposal backoff list (v1.1) — small state, its
 * own file, written only on the evolution path (inside the evolution lock).
 */
export const DIRECTION_REJECTED_PATH =
  "memory/evolution/fitness/direction-rejections.json";

/** Directory holding the per-sub-agent evolved playbooks (design §2.4). */
export const PLAYBOOK_DIR = "memory/agent-playbooks";

/** The sub-agents that carry an evolvable playbook. */
export type PlaybookAgent = "recall" | "search" | "thinkdeep";

export function playbookPath(agent: PlaybookAgent): string {
  return `${PLAYBOOK_DIR}/${agent}.md`;
}
