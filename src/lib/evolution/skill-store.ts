import {
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "@/lib/episodic/io-helpers";
import {
  applySkillOperation,
  emptySkillLedger,
  isSkillSourceRef,
  parseSkillLedger,
  type SkillLedger,
  type SkillMutationResult,
} from "./skill-policy";
import { opaqueContentRevision } from "./skill-revision";

export const SKILL_STATE_PATH = "memory/config/skill-state.json";

export type SkillLedgerReadResult =
  | { status: "ok"; ledger: SkillLedger }
  | { status: "missing"; ledger: SkillLedger }
  | { status: "corrupt"; ledger: null; diagnostic: string }
  | { status: "unavailable"; ledger: null; diagnostic: string };

export type SkillLedgerMutationResult =
  | SkillMutationResult
  | { status: "corrupt"; ledger: null; diagnostic: string }
  | { status: "unavailable"; ledger: null; diagnostic: string };

export type SkillSourceReadResult =
  | { status: "ok"; ref: string; content: string; revision: string }
  | { status: "missing"; ref: string; content: null; revision: string }
  | { status: "unavailable"; ref: string; content: null; revision: null; diagnostic: string };

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: unknown }).status;
  const code = (error as Error & { code?: unknown }).code;
  return status === 404 || code === "ENOENT" || error.message.startsWith("File not found:");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readSkillLedger(
  batch?: WriteBatch,
  options?: { fresh?: boolean },
): Promise<SkillLedgerReadResult> {
  let raw: string;
  try {
    raw = await fsReadFile(SKILL_STATE_PATH, batch, { fresh: options?.fresh === true });
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing", ledger: emptySkillLedger() };
    return { status: "unavailable", ledger: null, diagnostic: errorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "corrupt", ledger: null, diagnostic: `skill-state.json is not valid JSON: ${errorMessage(error)}` };
  }
  const result = parseSkillLedger(parsed);
  return result.ok
    ? { status: "ok", ledger: result.ledger }
    : { status: "corrupt", ledger: null, diagnostic: result.diagnostic };
}

export interface SkillStoreHost {
  /** Host-only clock override for deterministic runs/tests; never operation data. */
  now?: Date;
}

export function skillAdoptionBoundaryAt(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("invalid skill adoption clock");
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** Apply one explicit operation; the server alone stamps adoption boundaries. */
export async function mutateSkillLedger(
  operation: unknown,
  batch?: WriteBatch,
  host: SkillStoreHost = {},
): Promise<SkillLedgerMutationResult> {
  const current = await readSkillLedger(batch, { fresh: true });
  if (current.status === "corrupt" || current.status === "unavailable") return current;
  const result = applySkillOperation(current.ledger, operation, {
    adoptionBoundary: skillAdoptionBoundaryAt(host.now ?? new Date()),
  });
  if (result.status === "rejected" || result.status === "replayed") return result;
  await fsWriteFile(
    SKILL_STATE_PATH,
    `${JSON.stringify(result.ledger, null, 2)}\n`,
    batch,
  );
  return result;
}

/** Return source text/revision for candidate drafting or review; never auto-adopt it. */
export async function readSkillSource(
  ref: string,
  batch?: WriteBatch,
): Promise<SkillSourceReadResult> {
  if (!isSkillSourceRef(ref)) {
    return {
      status: "unavailable",
      ref,
      content: null,
      revision: null,
      diagnostic: "invalid skill source ref; expected self/<case>/index.md",
    };
  }
  try {
    const content = await fsReadFile(`memory/${ref}`, batch, { fresh: true });
    return {
      status: "ok",
      ref,
      content,
      revision: opaqueContentRevision("skill-source", ref, content),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: "missing",
        ref,
        content: null,
        revision: opaqueContentRevision("skill-source", ref, null),
      };
    }
    return {
      status: "unavailable",
      ref,
      content: null,
      revision: null,
      diagnostic: errorMessage(error),
    };
  }
}
