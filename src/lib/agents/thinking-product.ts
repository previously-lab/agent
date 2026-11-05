import { z } from "zod";
import type { ModelMessage } from "@/lib/deepseek/types";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";
import { parseCanonicalDocumentRef } from "@/lib/documents/document-link";
import { projectNativeReplySemantics } from "@/lib/markdown/native-reply-semantics";
import { collectThinkingReads, type ThinkingRead } from "./thinking-read-receipt";

const boundedId = z.string().min(1).max(512);
const findingKind = z.enum(["conversation", "project_fact", "historical_fact", "user_report",
  "observation", "external_result", "interpretation", "recommendation", "status", "unknown", "question"]);
const decisionKind = z.enum(["proposed", "confirmed", "rejected", "unresolved"]);

/** Optional terminal tool arguments. All identities, receipts and gates come from the host. */
export const thinkingReportSchema = z.object({
  findings: z.array(z.object({
    text: z.string().min(1).max(8000),
    kind: findingKind,
    evidenceIds: z.array(boundedId).max(24).optional(),
    requiredReadRefs: z.array(boundedId).max(16).optional(),
    scopeId: boundedId.optional(),
    uncertainty: z.string().max(600).optional(),
    decision: decisionKind.optional(),
    adoptionEvidenceIds: z.array(boundedId).max(8).optional(),
  }).strict()).max(12),
  openQuestions: z.array(z.string().min(1).max(400)).max(6).optional(),
  nextAction: z.string().max(600).optional(),
  memoryDelta: z.object({
    readerQuestion: z.string().min(1).max(400),
    newInformation: z.string().min(1).max(600),
    findingIndices: z.array(z.number().int().nonnegative().max(11)).min(1).max(8),
    targetRefs: z.array(boundedId).max(4),
  }).strict().optional(),
}).strict();

export type ThinkingReport = z.infer<typeof thinkingReportSchema>;
type DraftFinding = ThinkingReport["findings"][number];
export type ThinkingPublicMode = "finding" | "status" | "none";
export type ThinkingDependency = {
  ref: string;
  edition?: "current" | "original" | "history";
  turnId?: string;
  role?: "user" | "assistant";
  revision?: string;
  /** Host-created task/entity scope. Unscoped dependencies apply to the whole work. */
  scopeId?: string;
};
export interface ThinkingInputScope {
  scopeKey: string;
  workId: string;
  inputIds: readonly string[];
  inputText: string;
  readScopeId: string;
  locale?: string;
  taskRef?: string;
  entityRefs?: readonly string[];
  documentContext?: DocumentContextSnapshot;
  /** Stable independent scopes supplied by the host, never accepted from the model alone. */
  independentScopes?: readonly { id: string; refs: readonly string[] }[];
  unresolvedIdentity?: boolean;
}
export interface ThinkingClaim {
  claimId: string;
  text: string;
  kind: z.infer<typeof findingKind>;
  allowedPublicMode: ThinkingPublicMode;
  evidenceIds: string[];
  requiredReadRefs: string[];
  missingReadRefs: string[];
  uncertainty?: string;
  decision?: z.infer<typeof decisionKind>;
  adoptionEvidenceIds: string[];
  scopeId?: string;
}
export interface ThinkingProduct {
  version: 1;
  inputScope: Pick<ThinkingInputScope, "scopeKey" | "workId" | "inputIds" | "taskRef" | "entityRefs">;
  sourceRevision: string | null;
  asOf: string;
  status: "complete" | "incomplete";
  claims: ThinkingClaim[];
  readSet: ThinkingRead[];
  dependencies: ThinkingDependency[];
  openQuestions: string[];
  nextAction?: string;
  memoryDelta?: { readerQuestion: string; newInformation: string; claimIds: string[]; targetRefs: string[] };
}

export function thinkingDependencies(inputScope: ThinkingInputScope, required: readonly ThinkingDependency[] = []): ThinkingDependency[] {
  const selected = (inputScope.documentContext ?? []).map(({ ref, edition, turnId, role }): ThinkingDependency =>
    ({ ref, ...(edition ? { edition } : {}), ...(turnId ? { turnId } : {}), ...(role ? { role } : {}) }));
  const dependencies = new Map<string, ThinkingDependency>();
  const bound = (inputScope.entityRefs ?? []).filter((ref) => !required.some((dependency) => dependency.ref === ref))
    .map((ref) => ({ ref }));
  for (const dependency of [...required, ...selected, ...bound] as ThinkingDependency[]) {
    const ref = parseCanonicalDocumentRef(dependency.ref);
    if (!ref) throw new Error("Invalid host research dependency");
    const entry = { ...dependency, ref };
    dependencies.set(JSON.stringify([ref, entry.edition, entry.turnId, entry.role, entry.revision, entry.scopeId]), entry);
  }
  return [...dependencies.values()];
}

function satisfies(read: ThinkingRead, dependency: ThinkingDependency): boolean {
  // A case's historical index and its live _current view are separate reads.
  // An unspecified edition means the current view for semantic documents;
  // only an explicit original dependency may be satisfied by the index.
  // Original conversations remain eligible without an edition qualifier.
  const editionMatches = dependency.edition
    ? dependency.edition === read.edition
    : read.sourceKind !== "semantic_document" || read.edition !== "original";
  return read.ref === dependency.ref && Boolean(read.revision) &&
    (read.sourceKind === "original_turn" ? read.coverage === "excerpt" : read.coverage === "full") &&
    editionMatches &&
    (!dependency.turnId || dependency.turnId === read.turnId) &&
    (!dependency.role || dependency.role === read.role) &&
    (!dependency.revision || dependency.revision === read.revision);
}

function safeText(text: string): string {
  return projectNativeReplySemantics(text, "assistant").trim().slice(0, 8000);
}

/** Build from this attempt's real tool messages, never from client-replayed history. */
export function buildThinkingProduct(input: {
  text: string;
  messages: readonly ModelMessage[];
  inputScope: ThinkingInputScope;
  dependencies?: readonly ThinkingDependency[];
  sourceRevision?: string | null;
  asOf: string;
  report?: unknown;
  interrupted?: boolean;
}): ThinkingProduct {
  const { inputScope } = input;
  const dependencies = thinkingDependencies(inputScope, input.dependencies);
  const readSet = collectThinkingReads(input.messages, inputScope.readScopeId);
  const parsed = thinkingReportSchema.safeParse(input.report);
  const report = parsed.success ? parsed.data : undefined;
  const lang = inputScope.locale?.startsWith("zh") ? "zh" : "en";
  const fallback = safeText(input.text);
  // Plain short answers need no tool call. Plain research prose must still
  // pass the same dependencies and cannot upgrade anything to user-confirmed.
  const drafts: DraftFinding[] = report?.findings ?? (fallback ? [{ text: fallback,
    kind: dependencies.length || readSet.length ? "interpretation" : "conversation",
    evidenceIds: readSet.filter((read) => read.coverage === "full" || read.coverage === "excerpt").map((read) => read.evidenceId),
  }] : []);
  const byId = new Map(readSet.map((read) => [read.evidenceId, read]));
  const claims: ThinkingClaim[] = drafts.map((draft, index) => {
    const text = safeText(draft.text);
    const evidence = [...new Set(draft.evidenceIds ?? [])].flatMap((id) => {
      const read = byId.get(id);
      return read && read.revision && ["full", "range", "excerpt"].includes(read.coverage) ? [read] : [];
    });
    const scope = inputScope.independentScopes?.find((candidate) => candidate.id === draft.scopeId &&
      candidate.refs.some((ref) => evidence.some((read) => read.ref === ref &&
        (read.coverage === "full" || read.coverage === "excerpt"))));
    // No model-supplied empty dependency list or 'independent' flag can
    // replace the host's work bindings. Unscoped requirements always apply.
    const requirements = dependencies.filter((dependency) => !scope || !dependency.scopeId || dependency.scopeId === scope.id);
    for (const ref of draft.requiredReadRefs ?? []) {
      const canonical = parseCanonicalDocumentRef(ref);
      if (canonical && !requirements.some((dependency) => dependency.ref === canonical)) requirements.push({ ref: canonical });
    }
    const missingReadRefs = [...new Set(requirements.filter((dep) => !evidence.some((read) => satisfies(read, dep))).map((dep) => dep.ref))];
    const adoptionEvidenceIds = (draft.adoptionEvidenceIds ?? []).filter((id) => evidence.some((read) =>
      read.evidenceId === id && read.sourceKind === "original_turn" && read.role === "user" && read.excerpt?.trim()));
    // An exact excerpt from the current input can be repeated as a report.
    // This does not establish the truth or endorsement of quoted material.
    const currentReport = draft.kind === "user_report" && Boolean(text && inputScope.inputText.includes(text));
    const isStatus = draft.kind === "status" || draft.kind === "unknown" || draft.kind === "question";
    const needsEvidence = draft.kind === "project_fact" || draft.kind === "historical_fact" ||
      draft.kind === "external_result" || draft.kind === "observation" || draft.kind === "user_report" ||
      (draft.kind === "interpretation" && readSet.length > 0);
    const permitted = Boolean(text) && !input.interrupted &&
      (currentReport || (!missingReadRefs.length && !inputScope.unresolvedIdentity && (!needsEvidence || evidence.length > 0))) &&
      (draft.decision !== "confirmed" || adoptionEvidenceIds.length > 0);
    // A model-labeled status cannot carry an arbitrary blocked fact into the
    // expression prompt. When dependencies are missing use host status below.
    const allowedPublicMode: ThinkingPublicMode = isStatus
      ? (permitted ? "status" : "none") : (permitted ? "finding" : "none");
    return { claimId: `claim-${index + 1}`, text, kind: draft.kind, allowedPublicMode,
      evidenceIds: evidence.map((read) => read.evidenceId), requiredReadRefs: [...new Set(requirements.map((dep) => dep.ref))],
      missingReadRefs, adoptionEvidenceIds, ...(scope ? { scopeId: scope.id } : {}),
      ...(draft.uncertainty ? { uncertainty: safeText(draft.uncertainty) } : {}),
      ...(draft.decision ? { decision: draft.decision } : {}) };
  });
  const missing = dependencies.filter((dep) => !readSet.some((read) => satisfies(read, dep)));
  const incomplete = Boolean(input.interrupted || inputScope.unresolvedIdentity || missing.length ||
    claims.some((claim) => claim.allowedPublicMode === "none"));
  if (incomplete || !claims.length) claims.push({
    claimId: "status", kind: "status", allowedPublicMode: "status",
    text: input.interrupted
      ? (lang === "zh" ? "这项工作尚未完成。" : "This work is not complete yet.")
      : (lang === "zh" ? "相关依据还没核实。" : "The relevant evidence has not been verified yet."),
    evidenceIds: [], requiredReadRefs: [], missingReadRefs: missing.map((dependency) => dependency.ref), adoptionEvidenceIds: [],
  });
  const delta = report?.memoryDelta;
  const deltaClaims = delta?.findingIndices.map((index) => claims[index]);
  const memoryDelta = delta && deltaClaims?.every((claim) => claim?.allowedPublicMode === "finding" &&
    claim.evidenceIds.length > 0 && claim.kind !== "conversation")
    ? { readerQuestion: safeText(delta.readerQuestion), newInformation: safeText(delta.newInformation),
      claimIds: deltaClaims.map((claim) => claim.claimId),
      targetRefs: delta.targetRefs.flatMap((ref) => parseCanonicalDocumentRef(ref) ?? []) } : undefined;
  return {
    version: 1, inputScope: { scopeKey: inputScope.scopeKey, workId: inputScope.workId, inputIds: [...inputScope.inputIds],
      ...(inputScope.taskRef ? { taskRef: inputScope.taskRef } : {}),
      ...(inputScope.entityRefs?.length ? { entityRefs: [...inputScope.entityRefs] } : {}) },
    sourceRevision: input.sourceRevision ?? null, asOf: input.asOf, status: incomplete ? "incomplete" : "complete",
    claims, readSet, dependencies,
    // Model-authored open questions are useful inside the work. Expression
    // sees only admitted claims and structural gaps, not unchecked prose.
    openQuestions: report?.openQuestions?.map(safeText) ?? [],
    ...(report?.nextAction ? { nextAction: safeText(report.nextAction) } : {}),
    ...(memoryDelta ? { memoryDelta } : {}),
  };
}

export function thinkingExpressionClaims(product: ThinkingProduct): ThinkingClaim[] {
  return product.claims.filter((claim) => claim.allowedPublicMode !== "none");
}

/** Call from the publication transaction against the stored immutable result. */
export function permitsThinkingClaim(product: ThinkingProduct, claimId: string, mode: "finding" | "status"): boolean {
  return product.claims.some((claim) => claim.claimId === claimId && claim.allowedPublicMode === mode);
}
