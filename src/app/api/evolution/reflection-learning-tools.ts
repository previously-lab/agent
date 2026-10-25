import { z } from "zod";
import { tool } from "@/lib/deepseek/tools";
import { caseStorageRevision } from "@/lib/docs/case-doc";
import { createCaseReadScope, type CaseReadScope } from "@/lib/episodic/flash/librarian";
import { parseTurns } from "@/lib/episodic/turn-parser";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import { readSelfSopSnapshot, writeSelfSopVersioned, type SelfSopSnapshot } from "@/lib/evolution/store";
import type { SelfAgent } from "@/lib/evolution/paths";
import { canonicalScenarioFromRef } from "@/lib/evolution/slice-ref";
import { mutateSkillLedger, readSkillLedger, readSkillSource, type SkillSourceReadResult } from "@/lib/evolution/skill-store";
import { skillOperationSchema } from "@/lib/evolution/skill-policy";

export interface ReflectionReadState {
  scope: CaseReadScope;
  rawRecords: Map<string, string>;
  hasReadEvidence(): boolean;
  recordRound(sliceId: string, raw: string): void;
}

/** Receipts are owned by one HQ run; worker passes create their own scopes. */
export function createReflectionReadState(): ReflectionReadState {
  const original = createCaseReadScope();
  let read = false;
  const scope: CaseReadScope = {
    ...original,
    recordIndexRead(value) { original.recordIndexRead(value); read = true; },
    recordEvidence(ref, proof) { original.recordEvidence(ref, proof); if (original.hasEvidence(ref)) read = true; },
  };
  const rawRecords = new Map<string, string>();
  return {
    scope, rawRecords, hasReadEvidence: () => read,
    recordRound(sliceId, raw) {
      rawRecords.set(sliceId, raw);
      scope.recordEvidence(`records/${sliceId}`, { revision: caseStorageRevision(raw), coverage: "full" });
    },
  };
}

/** Check provenance against bytes returned by readRound, never summaries/agent.md. */
export function requireReadRawEvidence(state: ReflectionReadState, refs: string[]): string | null {
  if (refs.length === 0) return "record evidence is required";
  for (const ref of refs) {
    const normalized = ref.trim().replace(/^records\//, "");
    const scenario = canonicalScenarioFromRef(normalized);
    if (!scenario) return `invalid canonical record ref: ${ref}`;
    const raw = state.rawRecords.get(scenario);
    if (raw === undefined) return `readRound ${scenario} before citing it`;
    const turnId = normalized.slice(scenario.length + 1);
    if (turnId && !parseTurns(raw).turns.some((turn) => turn.turnId === turnId)) {
      return `record ${scenario} does not contain turn ${turnId}`;
    }
  }
  return null;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function buildReflectionLearningTools(batch: WriteBatch, state: ReflectionReadState) {
  const sopReads = new Map<SelfAgent, SelfSopSnapshot>();
  const sourceReads = new Map<string, SkillSourceReadResult>();
  return {
    readSelfSop: tool({
      description: "Read the COMPLETE effective SOP and its baseRevision before rewriting it; a failed read authorizes no write.",
      inputSchema: z.object({ agent: z.enum(["search", "thinkdeep"]) }).strict(),
      execute: async ({ agent }) => {
        try {
          const snapshot = await readSelfSopSnapshot(agent, batch);
          sopReads.set(agent, snapshot);
          return JSON.stringify({ ...snapshot, baseRevision: snapshot.revision });
        } catch (error) { sopReads.delete(agent); return `REJECTED: ${message(error)}`; }
      },
    }),
    writeSelfSop: tool({
      description: "Rewrite the full SOP from this run's readSelfSop baseRevision. It is short guidance, not an archive: dated investigator prose, never 工程侧/代码/实现/缺陷/修复/上报 or messages to the makers. Cite raw records actually read with readRound; give applicability and expected benefit. An expected benefit is not verified improvement. Writes queue in the round batch. Memory is a git tree, not a database: re-read after refusal. SOPs are exempt from the document write window.",
      inputSchema: z.object({
        agent: z.enum(["search", "thinkdeep"]), content: z.string().trim().min(1),
        baseRevision: z.string().min(1), evidence: z.array(z.string().min(1)).min(1).max(20),
        expectedBenefit: z.string().trim().min(1), applicability: z.string().trim().min(1),
      }).strict(),
      execute: async (args) => {
        const basis = sopReads.get(args.agent);
        if (!basis || basis.revision !== args.baseRevision) return "REJECTED: call readSelfSop in this run and use its baseRevision";
        const evidenceError = requireReadRawEvidence(state, args.evidence);
        if (evidenceError) return `REJECTED: ${evidenceError}`;
        if (!args.expectedBenefit.trim() || !args.applicability.trim()) return "REJECTED: benefit and applicability are required";
        try {
          const result = await withSliceLock("evolution", () => writeSelfSopVersioned(args.agent, args.content, args.baseRevision, batch));
          if (!result.applied) return `REJECTED: ${result.diagnostic}`;
          sopReads.delete(args.agent);
          return `OK — 已记录，随本轮一次落盘: memory/self/${args.agent}/index.md`;
        } catch (error) { return `REJECTED: ${message(error)}`; }
      },
    }),
    readSkillSource: tool({
      description: "Read the original self/<case>/index.md and sourceRevision for drafting, revising, adopting or reviewing a procedural skill. A source read never adopts its text.",
      inputSchema: z.object({ ref: z.string() }).strict(),
      execute: async ({ ref }) => {
        const read = await readSkillSource(ref, batch);
        if (read.status === "ok") sourceReads.set(ref, read); else sourceReads.delete(ref);
        const skillUpdates: Array<{ id: string; revision: number; reviewNeeded: boolean }> = [];
        if (read.status === "ok") {
          const ledger = await readSkillLedger(batch, { fresh: true });
          if (ledger.status === "ok") {
            for (const entry of ledger.ledger.entries.filter((item) => item.state === "adopted" && item.ref === ref && item.checkedSourceRevision !== read.revision)) {
              const checked = await withSliceLock("evolution", () => mutateSkillLedger({
                kind: "check_source", id: entry.id, expectedRevision: entry.revision,
                operationId: `hq:source:${entry.id}:${entry.revision}:${read.revision.split(":").slice(-2).join(":")}`,
                sourceRevision: read.revision,
              }, batch));
              if (checked.status === "applied") skillUpdates.push({ id: checked.entry.id, revision: checked.entry.revision, reviewNeeded: checked.entry.reviewNeeded });
            }
          }
        }
        return JSON.stringify({ ...read, ...(skillUpdates.length ? { skillUpdates } : {}) });
      },
    }),
    querySkills: tool({
      description: "Read the authoritative skill states and revisions. Candidates are not active instructions; adopted rules are hypotheses about better behavior, not proven improvement.",
      inputSchema: z.object({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
      execute: async ({ offset = 0, limit = 20 }) => {
        const read = await readSkillLedger(batch, { fresh: true });
        return JSON.stringify(read.status === "ok" || read.status === "missing"
          ? { status: read.status, entries: read.ledger.entries.slice(offset, offset + limit), total: read.ledger.entries.length }
          : read);
      },
    }),
    manageSkill: tool({
      description: "Propose/adopt/revise/review/retire a stable-id skill. Read its source and raw evidence first. Revise creates an inert candidate requiring explicit re-adoption. A positive review requires an observed later scenario. check_source/offer_review are host receipts, not model actions. All changes queue with this round's commit.",
      inputSchema: skillOperationSchema.refine((op) => op.kind !== "offer_review" && op.kind !== "check_source", "host-only operation"),
      execute: async (input) => {
        const parsed = skillOperationSchema.safeParse(input);
        if (!parsed.success) return `REJECTED: ${parsed.error.issues[0]?.message ?? "invalid skill operation"}`;
        const operation = parsed.data;
        if (operation.kind === "offer_review" || operation.kind === "check_source") return "REJECTED: host-only operation";
        const ledger = await readSkillLedger(batch, { fresh: true });
        if (ledger.status === "corrupt" || ledger.status === "unavailable") return `REJECTED: ${ledger.diagnostic}`;
        const entry = operation.kind === "propose" ? null : ledger.ledger.entries.find((item) => item.id === operation.id);
        if (operation.kind !== "propose" && !entry) return "REJECTED: unknown skill id";
        if (operation.kind !== "retire") {
          const ref = operation.kind === "propose" ? operation.draft.ref : entry!.ref;
          const basis = sourceReads.get(ref);
          if (!basis || basis.status !== "ok") return `REJECTED: readSkillSource ${ref} in this run first`;
          const fresh = await readSkillSource(ref, batch);
          if (fresh.status !== "ok" || fresh.revision !== basis.revision) return "REJECTED: skill source moved; readSkillSource again";
          const expectedSource = operation.kind === "propose" ? operation.draft.sourceRevision
            : operation.kind === "revise" ? operation.changes.sourceRevision
            : operation.kind === "adopt" ? entry!.sourceRevision : operation.checkedSourceRevision;
          if (expectedSource && expectedSource !== basis.revision) return "REJECTED: sourceRevision does not match the source actually read; revise a changed candidate before adopting";
          const evidence = operation.kind === "propose" ? operation.draft.evidence
            : operation.kind === "revise" ? operation.changes.evidence
            : operation.kind === "review" ? operation.reviewEvidence : entry!.evidence;
          const error = requireReadRawEvidence(state, evidence);
          if (error) return `REJECTED: ${error}`;
        }
        const result = await withSliceLock("evolution", () => mutateSkillLedger(operation, batch));
        return JSON.stringify(result);
      },
    }),
  };
}
