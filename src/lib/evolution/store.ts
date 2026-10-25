/**
 * Typed I/O over the evolution-owned memory surface (v0.19 R4/R5 — design
 * v0.19 §B.7 / §C.2 / §D.1):
 *
 *   - people/user/index.md — the folded user model (card + direction prose in
 *     ONE document). The evolution loop is the ONLY writer (HQ rounds, driven
 *     by field dispatches / the explicit memory_update channel); the reply
 *     segment and every other
 *     flow treat it as read-only. Injected every turn next to profile.md.
 *   - people/user/profile.md — the user's OWN self-description. The user is
 *     the only writer (they edit the file directly); the agent never writes
 *     it. On conflict with index.md the self-description wins — that
 *     discipline is stated at the injection site (steps.ts), not enforced
 *     here.
 *   - self/<name>/index.md — per-capability SOPs. Evolution writers receive
 *     the full effective working copy plus an opaque revision; versioned writes
 *     compare fresh state before replacing it. Spawn injection is bounded by
 *     the procedural-skill prompt policy, with original-source refs.
 *
 * Dual-root discipline (§D.1): every READ checks the new root first and falls
 * back to the legacy root (current-previously.md / evolution/direction.md /
 * user/profile.md / agent-playbooks/<name>.md); every WRITE lands on the new
 * root only. Missing files degrade to null / empty, never to errors — a fresh
 * deployment has no evolution data yet, and that is a normal state.
 *
 * The fitness store (events/signals/triggers) is RETIRED (§C.2): selection
 * pressure is now prose self-assessment under self/, and the only evolution
 * triggers left are the field dispatch (HQ's sole trigger — hq-agent.ts) and
 * the explicit memory_update channel (§A.3.2).
 */

import {
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import {
  PEOPLE_USER_INDEX_PATH,
  PEOPLE_USER_PROFILE_PATH,
  LEGACY_USER_CARD_PATH,
  LEGACY_USER_PROFILE_PATH,
  DIRECTION_PATH,
  selfSopPath,
  legacyPlaybookPath,
  type SelfAgent,
} from "./paths";
import { opaqueContentRevision } from "./skill-revision";

// ─── people/user/index.md — the folded user model (§B.7) ──────────────────

/**
 * The fold's mechanical seam: the card prose first, then the direction doc
 * after a horizontal-rule separator. ONE file (§B.7's 散文合体) — the seam
 * exists so the mutation machinery (card session / direction ops) can keep
 * editing its own half until the boundary run's prose writer (A2) takes over.
 * Injection and snapshots always use the FULL document.
 */
export const USER_MODEL_DIRECTION_SEPARATOR = "\n\n---\n\n";

export interface UserModel {
  /** The card half — what the user did / is doing / plans. */
  card: string;
  /** The direction half (portrait + hypotheses) — null when absent. */
  direction: string | null;
  /** The whole index.md exactly as stored (or composed from legacy roots). */
  full: string;
}

/** Compose the single index.md document from its two halves. */
export function composeUserModel(card: string, direction: string | null): string {
  const c = card.trim();
  const d = direction?.trim() ?? "";
  if (c && d) return `${c}${USER_MODEL_DIRECTION_SEPARATOR}${d}`;
  return c || d;
}

/** Split a stored index.md back into its halves (first separator wins). */
export function splitUserModel(full: string): { card: string; direction: string | null } {
  const idx = full.indexOf(USER_MODEL_DIRECTION_SEPARATOR.trim());
  if (idx < 0) return { card: full, direction: null };
  return {
    card: full.slice(0, idx).trim(),
    direction: full.slice(idx + USER_MODEL_DIRECTION_SEPARATOR.trim().length).trim() || null,
  };
}

/**
 * Read the folded user model. New root first; on a miss, compose in memory
 * from the legacy roots (the legacy card + the legacy direction doc) WITHOUT
 * writing anything back (§D.1 — no backfill). Returns null when neither root
 * holds anything (a fresh deployment).
 */
export async function readUserModel(batch?: WriteBatch): Promise<UserModel | null> {
  try {
    const full = await fsReadFile(PEOPLE_USER_INDEX_PATH, batch);
    if (full.trim()) {
      const { card, direction } = splitUserModel(full);
      return { card, direction, full: full.trim() };
    }
  } catch {
    // new root absent — fall through to the legacy roots
  }
  let card = "";
  try {
    card = (await fsReadFile(LEGACY_USER_CARD_PATH, batch)).trim();
  } catch {
    // no legacy card either
  }
  const direction = await readDirection(batch);
  if (!card && !direction) return null;
  return { card, direction, full: composeUserModel(card, direction) };
}

/**
 * Write the CARD half of the folded model (the evolution run's card write).
 * The direction half is preserved: read from the current index.md, else from
 * the legacy direction doc, then recomposed. New-root write only.
 */
export async function writeUserModelCard(
  card: string,
  batch?: WriteBatch,
): Promise<void> {
  const current = await readUserModel(batch);
  await fsWriteFile(
    PEOPLE_USER_INDEX_PATH,
    composeUserModel(card, current?.direction ?? null),
    batch,
  );
}

/**
 * Write the DIRECTION half of the folded model (the merged run's direction
 * write-back). The card half is preserved the same way. New-root write only.
 */
export async function writeUserModelDirection(
  direction: string,
  batch?: WriteBatch,
): Promise<void> {
  const current = await readUserModel(batch);
  await fsWriteFile(
    PEOPLE_USER_INDEX_PATH,
    composeUserModel(current?.card ?? "", direction),
    batch,
  );
}

/**
 * Read the user's self-description (profile.md). New root first, legacy
 * `memory/user/profile.md` on a miss. Returns null when absent — the
 * injection block is then omitted entirely.
 */
export async function readUserProfile(batch?: WriteBatch): Promise<string | null> {
  for (const path of [PEOPLE_USER_PROFILE_PATH, LEGACY_USER_PROFILE_PATH] as const) {
    try {
      const content = await fsReadFile(path, batch);
      if (content.trim()) return content;
    } catch {
      // absent on this root — try the next
    }
  }
  return null;
}

// ─── Direction document (legacy root — READ tolerance only) ───────────────

/**
 * Read the LEGACY standalone direction document (`memory/evolution/
 * direction.md`). Tolerant-read helper: the live location is the direction
 * half of people/user/index.md (see readUserModel). Returns null when the
 * file does not exist.
 */
export async function readDirection(batch?: WriteBatch): Promise<string | null> {
  try {
    const content = await fsReadFile(DIRECTION_PATH, batch);
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

/**
 * True when the direction doc has never actually been written — missing file,
 * or still the untouched bootstrap template (the "(Not set yet" placeholders
 * are the tell). Used by the direction agent's bootstrap gate.
 */
export function isDirectionTemplate(content: string | null): boolean {
  if (content === null) return true;
  return content.includes("(Not set yet");
}

// ─── self/ SOPs (§C.2) ─────────────────────────────────────────────────────

export type SelfSopOrigin = "new-root" | "legacy" | "missing";

export interface SelfSopSnapshot {
  agent: SelfAgent;
  origin: SelfSopOrigin;
  /** The complete effective working copy; null means no SOP on either root. */
  content: string | null;
  /** Opaque read basis. It changes with the effective origin or full content. */
  revision: string;
}

export type VersionedSelfSopWriteResult =
  | { applied: true; revision: string }
  | {
      applied: false;
      reason: "missing_basis" | "stale" | "unavailable" | "invalid";
      diagnostic: string;
    };

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: unknown }).status;
  const code = (error as Error & { code?: unknown }).code;
  return status === 404 || code === "ENOENT" || error.message.startsWith("File not found:");
}

function sopRevision(origin: SelfSopOrigin, content: string | null): string {
  return opaqueContentRevision("sop", origin, content);
}

/**
 * Fresh, batch-aware read of the complete effective SOP and its write basis.
 * Only a genuine miss falls through to the legacy root; an unavailable root is
 * not absence and must never authorize an overwrite.
 */
export async function readSelfSopSnapshot(
  agent: SelfAgent,
  batch?: WriteBatch,
  options?: { fresh?: boolean },
): Promise<SelfSopSnapshot> {
  const roots = [
    { origin: "new-root" as const, path: selfSopPath(agent) },
    { origin: "legacy" as const, path: legacyPlaybookPath(agent) },
  ];
  for (const root of roots) {
    try {
      const content = await fsReadFile(root.path, batch, { fresh: options?.fresh !== false });
      if (content.trim()) {
        return { agent, origin: root.origin, content, revision: sopRevision(root.origin, content) };
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return { agent, origin: "missing", content: null, revision: sopRevision("missing", null) };
}

export async function readSelfSop(
  agent: SelfAgent,
  batch?: WriteBatch,
): Promise<string | null> {
  return (await readSelfSopSnapshot(agent, batch, { fresh: false })).content;
}

/** Compare a recorded read basis with fresh effective state before writing. */
export async function writeSelfSopVersioned(
  agent: SelfAgent,
  content: string,
  expectedRevision: string,
  batch?: WriteBatch,
): Promise<VersionedSelfSopWriteResult> {
  if (!expectedRevision.trim()) {
    return { applied: false, reason: "missing_basis", diagnostic: `${agent} SOP write has no recorded read basis` };
  }
  if (!content.trim()) {
    return { applied: false, reason: "invalid", diagnostic: `${agent} SOP content is empty` };
  }
  let current: SelfSopSnapshot;
  try {
    current = await readSelfSopSnapshot(agent, batch);
  } catch (error) {
    return {
      applied: false,
      reason: "unavailable",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  if (current.revision !== expectedRevision) {
    return {
      applied: false,
      reason: "stale",
      diagnostic: `${agent} SOP changed after the recorded ${expectedRevision} read; fresh revision is ${current.revision}`,
    };
  }
  await fsWriteFile(selfSopPath(agent), content, batch);
  return { applied: true, revision: sopRevision("new-root", content) };
}

/** Legacy compatibility for the old HQ caller; new model-writable paths use the guarded writer. */
export async function writeSelfSop(
  agent: SelfAgent,
  content: string,
  batch?: WriteBatch,
): Promise<void> {
  await fsWriteFile(selfSopPath(agent), content, batch);
}
