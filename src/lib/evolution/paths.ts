/**
 * Path constants for the evolution data layer (v0.19 R4/R5 — the people/user
 * fold and the self/ move, design v0.19 §B.7 / §C.2 / §D.1).
 *
 * Everything here is memory DATA under `memory/` — the mutable surface the
 * evolution loop owns. The sub-agent contracts (schemas, tools, step budgets)
 * stay in `src/`; these files are what the evolution agent may rewrite
 * (people/user/index.md, self/<name>/index.md). Keeping the paths in one
 * module keeps every reader/writer byte-identical on where the truth lives.
 *
 * Dual-root discipline (§D.1): READS check the new root first and fall back
 * to the legacy root; WRITES land on the new root only. No backfill, no
 * migration — the next write moves the datum forward.
 */

/**
 * people/user/index.md — the agent's current understanding of the user: who
 * they are, what they're doing, what they plan (the card + direction prose
 * fold, §B.7). The ONLY case injected every turn, alongside profile.md.
 */
export const PEOPLE_USER_INDEX_PATH = "memory/people/user/index.md";

/**
 * people/user/profile.md — the user's OWN self-description. Only the user
 * writes it (by editing the file); on conflict with index.md the
 * self-description wins (charter discipline, stated at the injection site).
 */
export const PEOPLE_USER_PROFILE_PATH = "memory/people/user/profile.md";

/** Legacy roots — READ fallback only, never written (§D.1). The card lived
 *  at current-previously.md, the direction doc at evolution/direction.md,
 *  the self-description at user/profile.md. */
export const LEGACY_USER_CARD_PATH = "memory/episodic/current-previously.md";
export const LEGACY_DIRECTION_PATH = "memory/evolution/direction.md";
export const LEGACY_USER_PROFILE_PATH = "memory/user/profile.md";

/**
 * The cross-slice user-portrait document (design §2.2) — the direction half
 * of the fold. New writes ride INSIDE people/user/index.md (composed by the
 * store); this constant names the legacy standalone file for tolerant reads.
 */
export const DIRECTION_PATH = LEGACY_DIRECTION_PATH;

/**
 * self/ — the agent's own craft: per-capability SOP cases (§C.2).
 * `self/<name>/index.md` is the SOP document the engineering layer loads in
 * FULL into the corresponding sub-agent's system prompt at spawn; its tail
 * (dated prose) is the landing spot for self-assessment now that fitness
 * scoring is gone.
 */
export const SELF_DIR = "memory/self";

/** Legacy playbook root — READ fallback only (§D.1). */
export const LEGACY_PLAYBOOK_DIR = "memory/agent-playbooks";

/** The sub-agents that carry an evolvable SOP under self/. */
export type SelfAgent = "recall" | "search" | "thinkdeep";

export function selfSopPath(agent: SelfAgent): string {
  return `${SELF_DIR}/${agent}/index.md`;
}

/** Legacy playbook location — read fallback only. */
export function legacyPlaybookPath(agent: SelfAgent): string {
  return `${LEGACY_PLAYBOOK_DIR}/${agent}.md`;
}
