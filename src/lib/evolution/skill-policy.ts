import { z } from "zod";
import { opaqueContentRevision } from "./skill-revision";
import { canonicalScenarioFromRef, isCanonicalScenarioId } from "./slice-ref";
import { isValidCaseName } from "@/lib/docs/case-naming";

export const SKILL_LEDGER_SCHEMA_VERSION = 1;
export const SKILL_INSTRUCTION_MAX_CHARS = 1200;
export const SKILL_SUMMARY_MAX_CHARS = 240;
export const SKILL_APPLICABILITY_MAX_CHARS = 400;
export const SKILL_EXPECTED_BENEFIT_MAX_CHARS = 300;
export const SKILL_LEGACY_SOP_MAX_CHARS = 12000;
export const SKILL_PROMPT_MAX_CHARS = 6000;
export const SKILL_LEGACY_ROLE_PROMPT_MAX_CHARS = 18000;
export const SKILL_STATE_DIAGNOSTIC_MAX_CHARS = 500;
export const SKILL_GENERAL_MAX = 6;
export const SKILL_CATALOGUE_MAX = 12;

const SKILL_EVIDENCE_MAX = 20;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const skillRoleSchema = z.enum(["main", "search", "thinkdeep"]);
export type SkillRole = z.infer<typeof skillRoleSchema>;

export const skillStateSchema = z.enum(["candidate", "adopted", "retired"]);
export type SkillState = z.infer<typeof skillStateSchema>;

export const skillScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("general") }).strict(),
  z.object({ kind: z.literal("task"), trigger: z.string().trim().min(1).max(240) }).strict(),
]);
export type SkillScope = z.infer<typeof skillScopeSchema>;

function isDateOnly(value: string): boolean {
  if (!DATE_ONLY_RE.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

const dateOnlySchema = z.string().refine(isDateOnly, "expected a real YYYY-MM-DD date");
const scenarioIdSchema = z.string().refine(isCanonicalScenarioId, "expected a real canonical scenario id");
const evidenceRefSchema = z.string().trim().refine(
  (ref) => canonicalScenarioFromRef(ref) !== null,
  "expected a real canonical record slice or slice-turn ref",
);
const revisionSchema = z.string().trim().min(1).max(512);

export function isSkillSourceRef(ref: string): boolean {
  if (ref.length > 240 || ref.includes("\\") || /[\u0000-\u001f]/.test(ref)) return false;
  const parts = ref.split("/");
  if (parts.length !== 3 || parts[0] !== "self" || parts[2] !== "index.md") return false;
  const caseName = parts[1];
  if (/%[0-9a-f]{2}/i.test(caseName)) return false;
  return isValidCaseName(caseName);
}

/**
 * sourceRevision pins the source content behind THIS candidate instruction.
 * Adoption freezes that pairing; revise creates a new candidate instead of
 * silently moving an adopted instruction to new source content. checked and
 * acknowledged revisions record reviews only and never promote source text.
 */
const skillDraftShape = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected a stable lowercase skill id"),
  ref: z.string().refine(isSkillSourceRef, "expected self/<case>/index.md"),
  role: skillRoleSchema,
  scope: skillScopeSchema,
  applicability: z.string().trim().min(1).max(SKILL_APPLICABILITY_MAX_CHARS),
  instruction: z.string().trim().min(1).max(SKILL_INSTRUCTION_MAX_CHARS),
  summary: z.string().trim().min(1).max(SKILL_SUMMARY_MAX_CHARS),
  sourceRevision: revisionSchema,
  evidence: z.array(evidenceRefSchema).min(1).max(SKILL_EVIDENCE_MAX),
  expectedBenefit: z.string().trim().min(1).max(SKILL_EXPECTED_BENEFIT_MAX_CHARS),
  reviewDue: dateOnlySchema,
};

export const skillDraftSchema = z.object(skillDraftShape).strict();
export type SkillDraft = z.infer<typeof skillDraftSchema>;

export const skillRevisionPayloadSchema = z.object({
  instruction: skillDraftShape.instruction,
  applicability: skillDraftShape.applicability,
  evidence: skillDraftShape.evidence,
  sourceRevision: skillDraftShape.sourceRevision,
  summary: skillDraftShape.summary.optional(),
  expectedBenefit: skillDraftShape.expectedBenefit.optional(),
  reviewDue: skillDraftShape.reviewDue.optional(),
}).strict();
export type SkillRevisionPayload = z.infer<typeof skillRevisionPayloadSchema>;

export const skillReviewOutcomeSchema = z.enum([
  "pending",
  "positive",
  "negative",
  "inconclusive",
]);
export type SkillReviewOutcome = z.infer<typeof skillReviewOutcomeSchema>;

export const skillEntrySchema = z.object({
  ...skillDraftShape,
  revision: z.number().int().positive(),
  state: skillStateSchema,
  /** Host-stamped UTC scenario minute at this adoption, never a model input. */
  adoptionBoundary: scenarioIdSchema.optional(),
  reviewEvidence: z.array(evidenceRefSchema).max(SKILL_EVIDENCE_MAX),
  reviewOutcome: skillReviewOutcomeSchema,
  reviewedAt: dateOnlySchema.optional(),
  reviewNeeded: z.boolean(),
  checkedSourceRevision: revisionSchema.optional(),
  acknowledgedSourceRevision: revisionSchema,
}).strict().superRefine((entry, context) => {
  if (entry.reviewOutcome === "pending" && entry.reviewedAt) {
    context.addIssue({ code: "custom", message: "a pending review cannot have reviewedAt" });
  }
  if (entry.reviewOutcome !== "pending" && !entry.reviewedAt) {
    context.addIssue({ code: "custom", message: "a decided review needs reviewedAt" });
  }
  if (entry.reviewOutcome !== "pending" && entry.reviewEvidence.length === 0) {
    context.addIssue({ code: "custom", message: "a decided review needs record evidence" });
  }
});
export type SkillEntry = z.infer<typeof skillEntrySchema>;

export const appliedSkillOperationSchema = z.object({
  operationId: z.string().trim().min(1).max(160),
  fingerprint: z.string().min(1).max(512),
}).strict();
export type AppliedSkillOperation = z.infer<typeof appliedSkillOperationSchema>;

export const skillLedgerSchema = z.object({
  schemaVersion: z.literal(SKILL_LEDGER_SCHEMA_VERSION),
  entries: z.array(skillEntrySchema),
  operations: z.array(appliedSkillOperationSchema),
}).strict();
export type SkillLedger = z.infer<typeof skillLedgerSchema>;

const operationIdShape = { operationId: z.string().trim().min(1).max(160) };
const expectedRevisionShape = { expectedRevision: z.number().int().nonnegative() };

export const skillOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("propose"),
    ...operationIdShape,
    expectedRevision: z.literal(0),
    draft: skillDraftSchema,
  }).strict(),
  z.object({
    kind: z.literal("adopt"),
    ...operationIdShape,
    ...expectedRevisionShape,
    id: z.string(),
    reviewDue: dateOnlySchema,
  }).strict(),
  z.object({
    kind: z.literal("revise"),
    ...operationIdShape,
    ...expectedRevisionShape,
    id: z.string(),
    changes: skillRevisionPayloadSchema,
  }).strict(),
  z.object({
    kind: z.literal("review"),
    ...operationIdShape,
    ...expectedRevisionShape,
    id: z.string(),
    reviewEvidence: z.array(evidenceRefSchema).min(1).max(SKILL_EVIDENCE_MAX),
    reviewOutcome: z.enum(["positive", "negative", "inconclusive"]),
    reviewedAt: dateOnlySchema,
    reviewDue: dateOnlySchema,
    checkedSourceRevision: revisionSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("retire"),
    ...operationIdShape,
    ...expectedRevisionShape,
    id: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("check_source"),
    ...operationIdShape,
    ...expectedRevisionShape,
    id: z.string(),
    sourceRevision: revisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("offer_review"),
    ...operationIdShape,
    ...expectedRevisionShape,
    id: z.string(),
  }).strict(),
]);
export type SkillOperation = z.infer<typeof skillOperationSchema>;

export interface SkillPolicyHost {
  /** Server-owned current UTC minute; stamps adoption and bounds later reviews. */
  adoptionBoundary?: string;
}

export type SkillMutationResult =
  | { status: "applied"; ledger: SkillLedger; entry: SkillEntry }
  | { status: "replayed"; ledger: SkillLedger; entry: SkillEntry | null }
  | {
      status: "rejected";
      ledger: SkillLedger;
      code: "invalid" | "conflict" | "stale" | "state" | "evidence";
      diagnostic: string;
    };

export type SkillLedgerParseResult =
  | { ok: true; ledger: SkillLedger }
  | { ok: false; diagnostic: string };

export function emptySkillLedger(): SkillLedger {
  return { schemaVersion: SKILL_LEDGER_SCHEMA_VERSION, entries: [], operations: [] };
}

export function parseSkillLedger(input: unknown): SkillLedgerParseResult {
  const parsed = skillLedgerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostic: parsed.error.issues[0]?.message ?? "invalid skill ledger" };
  }
  const entryIds = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (entryIds.has(entry.id)) return { ok: false, diagnostic: `duplicate skill id "${entry.id}"` };
    entryIds.add(entry.id);
  }
  const operationIds = new Set<string>();
  for (const operation of parsed.data.operations) {
    if (operationIds.has(operation.operationId)) {
      return { ok: false, diagnostic: `duplicate operation id "${operation.operationId}"` };
    }
    operationIds.add(operation.operationId);
  }
  return { ok: true, ledger: parsed.data };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

function operationFingerprint(operation: SkillOperation): string {
  return opaqueContentRevision(
    "skill-operation",
    "ledger",
    JSON.stringify(canonicalValue(operation)),
  );
}

function withAppliedOperation(
  ledger: SkillLedger,
  entries: SkillEntry[],
  operation: SkillOperation,
  fingerprint: string,
): SkillLedger {
  return {
    ...ledger,
    entries,
    operations: [...ledger.operations, { operationId: operation.operationId, fingerprint }],
  };
}

function replaceEntry(ledger: SkillLedger, replacement: SkillEntry): SkillEntry[] {
  return ledger.entries.map((entry) => entry.id === replacement.id ? replacement : entry);
}

function staleRevision(entry: SkillEntry | undefined, expectedRevision: number): string | null {
  if (!entry) return "skill entry does not exist";
  return entry.revision === expectedRevision
    ? null
    : `stale skill revision: expected ${expectedRevision}, current ${entry.revision}`;
}

export function applySkillOperation(
  ledger: SkillLedger,
  input: unknown,
  host: SkillPolicyHost = {},
): SkillMutationResult {
  const parsed = skillOperationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "rejected",
      ledger,
      code: "invalid",
      diagnostic: parsed.error.issues[0]?.message ?? "invalid skill operation",
    };
  }
  const operation = parsed.data;
  const fingerprint = operationFingerprint(operation);
  const replay = ledger.operations.find((item) => item.operationId === operation.operationId);
  if (replay) {
    if (replay.fingerprint !== fingerprint) {
      return {
        status: "rejected",
        ledger,
        code: "conflict",
        diagnostic: `operation id "${operation.operationId}" was already used for another operation`,
      };
    }
    return {
      status: "replayed",
      ledger,
      entry: operation.kind === "propose"
        ? ledger.entries.find((entry) => entry.id === operation.draft.id) ?? null
        : ledger.entries.find((entry) => entry.id === operation.id) ?? null,
    };
  }

  if (operation.kind === "propose") {
    if (ledger.entries.some((entry) => entry.id === operation.draft.id)) {
      return {
        status: "rejected",
        ledger,
        code: "conflict",
        diagnostic: `skill id "${operation.draft.id}" already exists`,
      };
    }
    const entry: SkillEntry = {
      ...operation.draft,
      revision: 1,
      state: "candidate",
      adoptionBoundary: undefined,
      reviewEvidence: [],
      reviewOutcome: "pending",
      reviewNeeded: false,
      checkedSourceRevision: operation.draft.sourceRevision,
      acknowledgedSourceRevision: operation.draft.sourceRevision,
    };
    return {
      status: "applied",
      entry,
      ledger: withAppliedOperation(
        ledger,
        [...ledger.entries, entry],
        operation,
        fingerprint,
      ),
    };
  }

  const current = ledger.entries.find((entry) => entry.id === operation.id);
  const stale = staleRevision(current, operation.expectedRevision);
  if (stale || !current) {
    return {
      status: "rejected",
      ledger,
      code: current ? "stale" : "state",
      diagnostic: stale ?? "skill entry does not exist",
    };
  }

  if (operation.kind === "offer_review") {
    if (current.state !== "adopted") {
      return { status: "rejected", ledger, code: "state", diagnostic: "only an adopted skill can be offered for review" };
    }
    return {
      status: "applied",
      entry: current,
      ledger: withAppliedOperation(ledger, ledger.entries, operation, fingerprint),
    };
  }

  if (operation.kind === "adopt") {
    if (current.state !== "candidate") {
      return { status: "rejected", ledger, code: "state", diagnostic: "only a candidate can be adopted" };
    }
    if (!host.adoptionBoundary || !isCanonicalScenarioId(host.adoptionBoundary)) {
      return {
        status: "rejected",
        ledger,
        code: "invalid",
        diagnostic: "adoption needs a valid host-supplied UTC scenario boundary",
      };
    }
    const entry: SkillEntry = {
      ...current,
      state: "adopted",
      revision: current.revision + 1,
      adoptionBoundary: host.adoptionBoundary,
      reviewDue: operation.reviewDue,
      reviewEvidence: [],
      reviewOutcome: "pending",
      reviewedAt: undefined,
      reviewNeeded: false,
    };
    return {
      status: "applied",
      entry,
      ledger: withAppliedOperation(ledger, replaceEntry(ledger, entry), operation, fingerprint),
    };
  }

  if (operation.kind === "revise") {
    const entry: SkillEntry = {
      ...current,
      ...operation.changes,
      revision: current.revision + 1,
      state: "candidate",
      adoptionBoundary: undefined,
      reviewEvidence: [],
      reviewOutcome: "pending",
      reviewedAt: undefined,
      reviewNeeded: false,
      checkedSourceRevision: operation.changes.sourceRevision,
      acknowledgedSourceRevision: operation.changes.sourceRevision,
    };
    return {
      status: "applied",
      entry,
      ledger: withAppliedOperation(ledger, replaceEntry(ledger, entry), operation, fingerprint),
    };
  }

  if (operation.kind === "retire") {
    if (current.state === "retired") {
      return { status: "rejected", ledger, code: "state", diagnostic: "skill is already retired" };
    }
    const entry: SkillEntry = {
      ...current,
      state: "retired",
      revision: current.revision + 1,
      reviewNeeded: false,
    };
    return {
      status: "applied",
      entry,
      ledger: withAppliedOperation(ledger, replaceEntry(ledger, entry), operation, fingerprint),
    };
  }

  if (operation.kind === "check_source") {
    if (current.state !== "adopted") {
      return { status: "rejected", ledger, code: "state", diagnostic: "only an adopted skill has an active source review" };
    }
    const reviewNeeded = operation.sourceRevision !== current.acknowledgedSourceRevision;
    const changed = current.checkedSourceRevision !== operation.sourceRevision ||
      current.reviewNeeded !== reviewNeeded;
    const entry: SkillEntry = changed
      ? {
          ...current,
          revision: current.revision + 1,
          checkedSourceRevision: operation.sourceRevision,
          reviewNeeded,
        }
      : current;
    return {
      status: "applied",
      entry,
      ledger: withAppliedOperation(ledger, replaceEntry(ledger, entry), operation, fingerprint),
    };
  }

  if (current.state !== "adopted") {
    return { status: "rejected", ledger, code: "state", diagnostic: "only an adopted skill can be reviewed" };
  }
  if (operation.reviewOutcome === "positive") {
    const boundary = current.adoptionBoundary;
    const observedThrough = host.adoptionBoundary;
    const hasLaterScenario = boundary && isCanonicalScenarioId(boundary) &&
      observedThrough && isCanonicalScenarioId(observedThrough)
      ? operation.reviewEvidence.some((ref) => {
          const scenario = canonicalScenarioFromRef(ref);
          return scenario !== null && scenario > boundary && scenario <= observedThrough;
        })
      : false;
    if (!hasLaterScenario) {
      return {
        status: "rejected",
        ledger,
        code: "evidence",
        diagnostic: "a positive review needs evidence from a real scenario strictly later than adoption and no later than the host's current boundary",
      };
    }
  }
  const checkedSourceRevision = operation.checkedSourceRevision ?? current.checkedSourceRevision;
  const entry: SkillEntry = {
    ...current,
    revision: current.revision + 1,
    state: operation.reviewOutcome === "negative" ? "retired" : "adopted",
    reviewEvidence: operation.reviewEvidence,
    reviewOutcome: operation.reviewOutcome,
    reviewedAt: operation.reviewedAt,
    reviewDue: operation.reviewDue,
    checkedSourceRevision,
    acknowledgedSourceRevision: operation.checkedSourceRevision ?? current.acknowledgedSourceRevision,
    reviewNeeded: operation.reviewOutcome === "negative"
      ? false
      : operation.checkedSourceRevision
        ? false
        : current.reviewNeeded,
  };
  return {
    status: "applied",
    entry,
    ledger: withAppliedOperation(ledger, replaceEntry(ledger, entry), operation, fingerprint),
  };
}

export function listDueSkillReviews(
  ledger: SkillLedger,
  today: string,
  role?: SkillRole,
): SkillEntry[] {
  return ledger.entries
    .filter((entry) => entry.state === "adopted" && (!role || entry.role === role))
    .filter((entry) => entry.reviewNeeded || entry.reviewDue <= today)
    .sort((left, right) => compareText(left.reviewDue, right.reviewDue) || compareText(left.id, right.id));
}

export interface LegacySopPromptInput {
  content: string;
  ref: string;
}

export interface SkillPromptOmission {
  kind: "legacy_sop" | "general" | "catalogue";
  reason: "oversize" | "budget" | "duplicate";
  ref: string;
  id?: string;
}

export interface SkillPromptRender {
  text: string;
  selectedSkillIds: string[];
  omissions: SkillPromptOmission[];
}

interface PromptBlock {
  text: string;
  kind: SkillPromptOmission["kind"];
  ref: string;
  id?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRule(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function skillPromptBudget(role: SkillRole): number {
  return role === "main" ? SKILL_PROMPT_MAX_CHARS : SKILL_LEGACY_ROLE_PROMPT_MAX_CHARS;
}

function boundedDiagnostic(diagnostic: string | undefined): string | undefined {
  if (!diagnostic) return undefined;
  if (diagnostic.length <= SKILL_STATE_DIAGNOSTIC_MAX_CHARS) return diagnostic;
  const marker = "… [diagnostic truncated]";
  return `${diagnostic.slice(0, SKILL_STATE_DIAGNOSTIC_MAX_CHARS - marker.length)}${marker}`;
}

function noticeBlock(
  omissions: SkillPromptOmission[],
  diagnostic: string | undefined,
  finalBudget: number,
): string {
  const notices: string[] = [];
  for (const omission of omissions.filter((item) => item.kind === "legacy_sop")) {
    notices.push(
      `Legacy SOP omitted (${omission.reason === "oversize" ? `over the ${SKILL_LEGACY_SOP_MAX_CHARS}-character legacy budget` : `over the ${finalBudget}-character total budget`}); no partial rule was injected. Read the original: ${omission.ref}.`,
    );
  }
  for (const kind of ["general", "catalogue"] as const) {
    const count = omissions.filter((item) => item.kind === kind && item.reason !== "duplicate").length;
    if (count > 0) {
      notices.push(`${count} adopted ${kind} skill entr${count === 1 ? "y was" : "ies were"} omitted to respect prompt bounds; no partial rules were injected. Their ids remain available in the ledger.`);
    }
  }
  const bounded = boundedDiagnostic(diagnostic);
  if (bounded) notices.push(bounded);
  return notices.length > 0 ? `## Skill coverage notices\n\n${notices.join("\n")}` : "";
}

function assemblePrompt(
  selected: PromptBlock[],
  omissions: SkillPromptOmission[],
  role: SkillRole,
  diagnostic: string | undefined,
  finalBudget: number,
): string {
  const blocks: string[] = [];
  let general = 0;
  let catalogue = 0;
  for (const block of selected) {
    if (block.kind === "legacy_sop") {
      blocks.push(block.text);
    } else if (block.kind === "general") {
      const header = general === 0 ? `## Adopted procedural skills — always-on for ${role}\n\n` : "";
      blocks.push(header + block.text);
      general += 1;
    } else {
      const header = catalogue === 0
        ? "## Task-specific skill catalogue — references only, not active instructions\n\nSelect a row only by reading its original source for this task; no trigger text is pattern-matched into a mandatory rule.\n\n"
        : "";
      blocks.push(header + block.text);
      catalogue += 1;
    }
  }
  const notices = noticeBlock(omissions, diagnostic, finalBudget);
  if (notices) blocks.push(notices);
  return blocks.join("\n\n");
}

/** Adopted general rules are active; task rules are refs only until explicitly read and selected. */
export function renderRoleSkillGuidance(options: {
  role: SkillRole;
  ledger?: SkillLedger | null;
  legacySop?: LegacySopPromptInput | null;
  stateDiagnostic?: string;
  /** Characters the caller reserves around this block in its final prompt. */
  hostReservedChars?: number;
}): SkillPromptRender {
  const omissions: SkillPromptOmission[] = [];
  const selected: PromptBlock[] = [];
  const requestedReservation = options.hostReservedChars ?? 0;
  const reservation = Number.isNaN(requestedReservation)
    ? 0
    : Math.max(0, Math.floor(requestedReservation));
  const finalBudget = Math.max(0, skillPromptBudget(options.role) - reservation);
  let legacyInjected = "";

  const legacy = options.legacySop?.content.trim();
  if (options.legacySop && legacy) {
    if (legacy.length > SKILL_LEGACY_SOP_MAX_CHARS) {
      omissions.push({ kind: "legacy_sop", reason: "oversize", ref: options.legacySop.ref });
    } else {
      selected.push({
        text: `## Legacy SOP (${options.legacySop.ref})\n\n${legacy}`,
        kind: "legacy_sop",
        ref: options.legacySop.ref,
      });
      legacyInjected = normalizedRule(legacy);
    }
  }

  const active = (options.ledger?.entries ?? [])
    .filter((entry) => entry.state === "adopted" && entry.role === options.role)
    .sort((left, right) => compareText(left.id, right.id));
  const general = active.filter((entry) => entry.scope.kind === "general");
  const catalogue = active.filter((entry) => entry.scope.kind === "task");
  let generalCount = 0;
  let catalogueCount = 0;

  for (const entry of [...general, ...catalogue]) {
    const isGeneral = entry.scope.kind === "general";
    const kind = isGeneral ? "general" : "catalogue";
    const count = isGeneral ? generalCount : catalogueCount;
    const cap = isGeneral ? SKILL_GENERAL_MAX : SKILL_CATALOGUE_MAX;
    if (count >= cap) {
      omissions.push({ kind, reason: "budget", ref: entry.ref, id: entry.id });
      continue;
    }
    const duplicate = legacyInjected && [entry.instruction, entry.summary]
      .some((rule) => legacyInjected.includes(normalizedRule(rule)));
    if (duplicate) {
      omissions.push({ kind, reason: "duplicate", ref: entry.ref, id: entry.id });
      continue;
    }
    if (isGeneral) generalCount += 1;
    else catalogueCount += 1;
    selected.push({
      text: isGeneral
        ? `- [${entry.id}] ${entry.instruction}\n  Summary: ${entry.summary}\n  Applicability: ${entry.applicability} · Source: ${entry.ref}`
        : `- [${entry.id}] Trigger: ${entry.scope.kind === "task" ? entry.scope.trigger : ""} · Applicability: ${entry.applicability}\n  Summary: ${entry.summary}\n  Read original: ${entry.ref}`,
      kind,
      ref: entry.ref,
      id: entry.id,
    });
  }

  let text = assemblePrompt(selected, omissions, options.role, options.stateDiagnostic, finalBudget);
  while (text.length > finalBudget && selected.length > 0) {
    const removed = selected.pop()!;
    omissions.push({ kind: removed.kind, reason: "budget", ref: removed.ref, id: removed.id });
    text = assemblePrompt(selected, omissions, options.role, options.stateDiagnostic, finalBudget);
  }
  if (text.length > finalBudget) {
    const fallback = `## Skill coverage notices\n\nSkill guidance and its diagnostic were omitted to respect the ${finalBudget}-character prompt budget; no partial rules were injected.`;
    text = fallback.length <= finalBudget ? fallback : "";
  }
  return {
    text,
    selectedSkillIds: selected.flatMap((block) => block.id ? [block.id] : []),
    omissions,
  };
}
