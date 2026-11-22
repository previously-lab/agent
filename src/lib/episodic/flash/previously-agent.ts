/**
 * One writer maintains the two views in people/user/index.md. Previously keeps
 * established personal history and current threads. Direction keeps supported
 * patterns and optional hypotheses about the user's response in other contexts.
 * Both can stay unchanged. The pass edits working copies through tools; the
 * caller validates and persists the result. Allowed self/ SOPs describe the
 * agent's own practice. Historical notes are reviewed in their original scope.
 */

import { tool } from "@/lib/deepseek/tools";
import { type Tool } from "@/lib/deepseek/types";
import { z } from "zod";
import type { ModelConfig } from "@/lib/models/registry";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import { RECORD_ATTRIBUTION_RULE, renderAttributedTurns } from "../record-attribution";
import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import { MEMORY_IS_GIT_RULE } from "@/lib/docs/write-window";
import type { SelfAgent } from "@/lib/evolution/paths";
import type { SelfSopSnapshot } from "@/lib/evolution/store";
import { canonicalScenarioFromRef } from "@/lib/evolution/slice-ref";
import {
  renderDirectionAnalysis,
  renderDirectionMarkings,
  applyDirectionOps,
  emptyDirectionDoc,
  type DirectionMarking,
  type DirectionMode,
  type DirectionOp,
} from "@/lib/evolution/direction-agent";
import type { TurnAnalysis } from "@/lib/episodic/flash/turn-analyzer";
import {
  parseCard,
  projectLivePreviously,
  CARD_NOW_EXPIRY_DAYS,
  CARD_PROFILE_MAX_CHARS,
  NOW_ITEM_MAX_CHARS,
  PAST_ANCHOR_MAX_CHARS,
  CARD_NOW_MAX,
  PAST_ANCHORS_MAX,
} from "../previously-format";
import {
  createCardSession,
  serializeSession,
  sessionSetIdentity,
  sessionUpdatePastProfile,
  sessionAddPastAnchor,
  sessionRemovePastAnchor,
  sessionAddNow,
  sessionRemoveNow,
  sessionPromoteNowToPast,
  type CardSession,
} from "../card-session";

// ─── Types ──────────────────────────────────────────────────────────────

export type PreviouslySignal =
  | "new_observation"
  | "slice_closed"
  | "field_report"
  | "self_reflection";

/**
 * One SOP mutation the agent proposed and the code ACCEPTED (the caller
 * allowed it). Written to disk by the caller (runCardEvolution) — this module
 * stays side-effect-free except through the caller-provided reader callbacks.
 */
export interface SopWrite {
  agent: SelfAgent;
  /** The full proposed replacement; spawn injection is separately bounded. */
  content: string;
  evidence: string[];
  expectedBenefit: string;
  applicability: string;
  /** Recorded full-read basis, compared with fresh effective state on write. */
  baseRevision: string;
}

/**
 * The direction half of the merged run (v1.1): when present, the agent FIRST
 * evaluates direction.md (portrait + hypothesis pool + legacy Self-model
 * migration) and edits its working copy through the direction MUTATION tools
 * (addPortraitEntry / addHypothesis / …) — never a whole-doc rewrite. Absent
 * on explicit-request runs — the direction stays boundary-scoped.
 */
export interface DirectionEvalInput {
  /** Current direction.md content — null when never set. */
  current: string | null;
  /** bootstrap / migrate / steady — the evidence bar (≥1 / ≥1 / ≥2 pointers). */
  mode: DirectionMode;
  /** The card's legacy Self-model lines verbatim — to be folded into the
   *  Portrait (descriptive phrasing, keep slice refs). Null when none. */
  cardSelfModel: string | null;
  /** Recent closed slices' markings, newest first. */
  recentMarkings?: DirectionMarking[];
  /** This slice's analyzer output — the freshest evidence. */
  analysis: TurnAnalysis;
}

export interface PreviouslyAgentInput {
  signal: PreviouslySignal;
  note: string;
  /** The model running the review — the turn's MAIN model (v0.9 unified runner). */
  model: ModelConfig;
  /** Slice the card belongs to. */
  currentSliceId: string;
  /** When a slice just closed, its id (triggers a deeper whole-slice review). */
  closedSliceId?: string;
  /** The current card — pre-loaded by the executor. */
  previouslyContent: string;
  /** The recent exchange (the closed slice's turns, or the active exchange). */
  recentTurns: Array<{ role: string; content: string; turnId?: string; timestamp?: string }>;
  /** @deprecated Slice tags stopped being written in v0.19 R2 (always `[]`);
   *  the prompt no longer renders them. Tolerated for older callers only. */
  currentSliceTags?: string[];
  /** The user's LOCAL calendar date (YYYY-MM-DD) — Now ages / overdue checks
   *  compare against the user's clock, and it is the default `since`. */
  todayLocal?: string;

  // ── Evolution context (v1.0/v1.1) ────────────────────────────────────────

  /**
   * When available, this pass may revise case-independent user patterns and hypotheses.
   */
  directionEval?: DirectionEvalInput;
  /**
   * Orientation-only direction content (the explicit-request path, where no
   * direction evaluation runs). It supplies context only.
   * Ignored when `directionEval` is set (its `current` is used instead).
   */
  direction?: string | null;
  /**
   * The user's OWN self-description (people/user/profile.md), when one exists
   * (§B.7): only the user writes it, so on any conflict with the model you
   * maintain, THE SELF-DESCRIPTION WINS — fold the model toward it, never the
   * other way around.
   */
  userProfile?: string | null;
  /**
   * The self/ colleagues whose SOP this run may rewrite (v0.19 §C.2 — HQ's
   * merged card run lists them; the explicit memory_update channel passes
   * NONE, so writeSop rejects every call there). Absent/empty → all SOP
   * writes REJECTED.
   */
  allowedSopWrites?: SelfAgent[];
  /** Complete old working copies and opaque read bases for every writable SOP. */
  sopSnapshots?: Partial<Record<SelfAgent, SelfSopSnapshot>>;

  // ── Tool implementations (callbacks provided by the executor) ──────

  readSliceFn: (sliceId: string, range?: {
    type: "turns" | "last" | "date";
    indices?: number[];
    count?: number;
    after?: string;
  }) => Promise<string>;
  readAgentTimelineFn: (sliceId: string) => Promise<string>;
  readPreviouslyFn: (sliceId: string) => Promise<string>;

  /**
   * Live-line callback for the agent's streaming thinking/writing — wired by
   * housekeeping onto the `data-evolution` channel (the Previously Agent does
   * not run as a tool call, so the runner's toolCallId emitter is noop).
   * Unthrottled; the caller throttles.
   */
  onLine?: (line: string, stage: "thinking" | "writing") => void;
}

export interface PreviouslyAgentOutput {
  /** The serialized card after the session's mutations. Empty on failure. */
  updatedCard: string;
  reasoning: string;
  /** ONE user-language sentence describing what changed — shown in the UI and
   *  handed to the core agent. Empty when nothing changed. */
  summary: string;
  /** Compact log of every applied card mutation ("addNow: …"). */
  mutations: string[];
  /**
   * True when the pass ended WITHOUT a finish call (step cap / plain-text
   * stop): `updatedCard` carries whatever mutations landed before the pass
   * stopped. NOT a failure — the caller writes the partial card back.
   */
  partial?: boolean;
  /**
   * True when the agent FAILED (unreachable, timed out) as opposed to
   * legitimately deciding "nothing to update" — the caller must not present
   * a failure as a clean no-change result.
   */
  failed?: boolean;
  /**
   * Accepted SOP mutations (v0.19 §C.2 — one per allowed self/ colleague).
   * NOT yet written to disk — the caller applies them (writeSelfSop) next to
   * the card write-back.
   */
  sopWrites?: SopWrite[];
  /** The agent's one-line expected benefit for this pass's changes (design
   *  §2.7 — recorded with the SOP write). */
  expectedBenefit?: string;
  /**
   * The direction half's outcome (v1.1 merged run) — present only when
   * `directionEval` was set AND the agent's direction MUTATION OPS actually
   * changed the working doc. NOT yet written: the caller runs the whole-doc
   * gate (validateDirectionProposal, mode-aware) + the engineering TTL
   * (retireExpiredHypotheses) and applies through writeUserModelDirection; a
   * rejection
   * is logged and skipped, never fatal.
   */
  direction?: { doc: string; summary: string; checkedMutations?: true };
}

// ─── Prompt ────────────────────────────────────────────────────────────
// v0.9 unified sub-agent architecture: the SYSTEM prompt is fully static
// (SHARED_SUBAGENT_BASE + the role block below) so every call shares one
// prefix cache entry; ALL per-call content (time context, signal, the current
// card, the direction evidence, the recent conversation) goes in the USER
// prompt.

const PREVIOUSLY_ROLE = `You are the Previously Agent. You maintain two complementary views of the user for future conversations.

${MEMORY_IS_GIT_RULE}

The task may offer tools for both views and for an applicable self/ SOP. Each view can stay unchanged independently. Direction interprets evidence; its hypotheses are never evidence for the card.

## What the card is

Previously is the retrospective half of people/user/index.md. It gives a future conversation just enough factual background to pick up the user's story.
1. **Identity** records the user's name, form of address, pronouns and aliases.
2. **Past** is a compact account of established experiences, background and turning points that still help explain the user's situation today. Keep self-reports in the user's terms. A description of what they do does not establish a purpose they never gave. Cite the underlying records for anchors. Keep a short paragraph or leave it empty.
3. **Now** may point to an ongoing thread worth carrying across conversations. A passing activity can live entirely in its subject's case. Review hooks older than ${CARD_NOW_EXPIRY_DAYS} days for continuing relevance.

Commitments, deadlines, awaited replies, next actions, and task outcomes belong EXCLUSIVELY to the task ledger and \`tasks/\` cases. Never create or maintain a Horizon section. A Now hook may point to a task as a current thread, but must not restate its deadline, lifecycle status, or next action.

The raw evidence lives in the time slices; the card only summarizes and points at them via refs. Event, task and research cases are authoritative for fast-changing facts. This model is BACKGROUND CONTEXT and a semantic directory, not an encyclopedia: retain only stable high-level understanding and useful links, while details, evidence and current research live in their own case documents. Never copy the same conclusion into both the card and Portrait, or repeat a case's explanation merely because it matters. Now keeps only the current thread's label and pointers to those cases and their source slices — never a second copy of changing status, dates, decisions or research details.

**LENGTH DISCIPLINE (hard)**: the card is an OVERVIEW, not a warehouse — it is injected into EVERY turn, so it must CONVERGE in length. Fold, compress, and drop hooks as they settle; never let the card grow monotonically. Detail stays in the slices (cite them via refs).

**THE USER'S SELF-DESCRIPTION WINS**: when the task carries a "User's self-description" section (people/user/profile.md — written by the user themselves, never by you), treat it as authoritative. On any conflict between it and the model you maintain, fold YOUR model toward the self-description.

## Choosing the subject

An isolated visit can update a place. A major relocation may also change the user's life story. A difficult night belongs with the place; a question about whether they will leave belongs there too. Previously may record a period of disrupted sleep if it became an important part of their history. Looking up a notice once is ordinarily complete in its local account. A personal trait needs separate support.
Keep commitments in the task ledger. Operating lessons concern the agent's own practice. Legacy Self-model material mixes subjects: identify whose conduct it describes and check the original observations before adopting any personal interpretation. An old instruction to the assistant supplies no evidence of a user trait.

## Language and house style

${DOC_LANGUAGE_RULE}

${DOC_HOUSE_STYLE}

## The direction discipline (portrait + hypothesis pool)

Direction is the interpretive half. It can help anticipate the user's response in comparable circumstances. The six existing Portrait headings are lenses; any of them may stay empty. Describe the conditions under which the pattern holds and carry forward counterexamples that limit it.
- **Portrait** holds supported patterns and the user's explicit self-descriptions, in their stated scope. Each new claim needs its own evidence. Compare independent situations; several accounts of the same incident describe one situation. If the user explicitly says a preference holds across settings, cite their words. A past write, a case title, a hypothesis and the assistant's wording cannot corroborate one another.
- **Hypotheses** may hold a conditional, falsifiable expectation when a concrete observation gives a reason to consider it. Someone who reports being disturbed specifically by sudden noises while resting might react similarly in another quiet setting. State what observation would count against that reading. Ordinary discomfort in an exceptionally loud room needs no personal explanation. A single memory question or an unanswered reply establishes no enduring motive or preference. Leave the pool empty or unchanged when the record adds nothing.
- Revisit a hypothesis when evidence bears on it. Independent observations in different contexts, or an explicit self-description, can justify promotion. Contradictory evidence may narrow or refute it. Engineering retires an unverified guess after four newer slices; expiry says nothing about its truth. Bootstrap and migration follow the same standards.

## How you write the card — MUTATIONS, never the whole file

You edit an in-memory copy of the card through write tools. Each write is validated: over-limit or malformed writes come back REJECTED with instructions — compress and retry; YOU decide what survives a cap (nothing is ever truncated silently — unless the loop brake force-applies a write you kept resubmitting identically, truncated to the cap). Entries you never touch stay exactly as they are. Removal tools take a \`match\` substring of the entry you mean.

| Tool | When to use |
|------|-------------|
| \`setIdentity(field, value)\` | field ∈ name / address_as / pronouns / alias. Sets or replaces that line. |
| \`updatePastProfile(text)\` | Rewrite the rolling profile paragraph IN PLACE (≤ ${CARD_PROFILE_MAX_CHARS} chars). |
| \`addPastAnchor(text, refs)\` / \`removePastAnchor(match)\` | Established fact of enduring relevance to the user's history, ≤ ${PAST_ANCHOR_MAX_CHARS} chars, refs required, ≤ ${PAST_ANCHORS_MAX} total. |
| \`addNow(text, refs, since?)\` / \`removeNow(match)\` / \`promoteNowToPast(match)\` | Current-state hook, ≤ ${NOW_ITEM_MAX_CHARS} chars, refs required, ≤ ${CARD_NOW_MAX} total. \`since\` defaults to today. Promote moves the hook to Past anchors (keeps refs). |
| \`writeSop(agent, content, evidence, expectedBenefit, applicability)\` | Rewrite a self/ colleague's SOP from its recorded full read (agent ∈ search / thinkdeep). GATED by the allowlist and read basis. Evidence, expected benefit, and applicability must each be nonempty. |
| \`readSlice(sliceId, range?)\` | Read conversation from any slice. Verify what the user actually said. |
| \`readAgentTimeline(sliceId)\` | Read agent.md — the reasoning + tool calls. Process context for judging how interactions went. |
| \`readPreviously(sliceId)\` | Read a past slice's card snapshot. Check how long a fact has been held. |
| \`addPortraitEntry(dimension, text, refs)\` / \`updatePortraitEntry(match, text, refs)\` / \`removePortraitEntry(match)\` | Direction mutations — CONFIRMED portrait entries (present only on a direction-evaluation run). |
| \`addHypothesis(text, falsify)\` / \`promoteHypothesis(match, dimension, text, refs)\` / \`removeHypothesis(match)\` | Direction mutations — the guess pool. Engineering stamps \`[proposed]\` and enforces the expiry TTL. |
| \`finish(reasoning, summary, expectedBenefit?, directionSummary?)\` | REQUIRED, LAST call — ends the pass. \`summary\` is ONE sentence IN THE USER'S LANGUAGE describing what changed (shown to the user + the core agent); empty when nothing changed. \`directionSummary\` notes what moved in direction.md — only when you moved it. Call finish even when nothing changed. |

## What to do — fold in the NEW evidence only

Compare the conversation in the task against the current card. Incorporate anything NEW and durable; resolve or remove what is stale. **Preserve what is still accurate and well-formed** — do not re-derive content from history, do not rewrite what already reads well.

- Add a Past fact or anchor when it earns a place in a brief account of the user's history. Preserve milestones and reversals with their original scope. A case can be enough on its own.
- Add a Now hook when the conversation benefits from an ongoing thread or a pointer to its case.
- A commitment, deadline, awaited reply, or task-state report → NO task content in the card; the field/reflection task tools own it. Record only a durable outcome or a minimal current-thread pointer when independently useful.
- Keep an explicit durable preference in the Portrait. Correct the relevant existing fact when the user corrects it.
- Fragmented or mixed-language card content → rewrite those entries cleanly in the user's language while preserving substance.
- Nothing new AND the card is already clean → make no writes; just \`finish\` with a short reasoning.

## self/ — SOPs and self-assessment

You also maintain your colleagues' SOPs — the \`self/<name>/index.md\` documents. The task includes each allowed document's COMPLETE old working copy and its recorded read basis. Preserve unrelated still-valid rules. \`writeSop\` is accepted only for an allowed colleague with that recorded read; evidence, expected benefit, and applicability are all required. Spawn injection is bounded separately, so keep the document tight and readable as whole rules.

**Evidence discipline**: with fitness scoring gone, your only credential is the record. Cite the records slice ids in the prose itself ("because slice 2026-08-07-0709 showed …") and in the evidence array. An SOP change without slice-id citations is worthless — never propose one. Applicability says exactly when the rule applies; expected benefit is a hypothesis to review, not verified improvement.

**Style discipline — the investigator's account, never the work order**: anchor a procedural observation in what happened, where it can be checked and how that experience changed the agent's practice. For example, a search returned a title but reading it failed. Record the failed check before relying on that source again. Keep implementation commentary out of the case.

**Self-assessment**: dissatisfaction with your own craft ("three searches this week missed, the order is suspect") lands as DATED PROSE at the tail of the relevant self/ case's index.md — no thresholds, no scores. When you rewrite an SOP, fold or supersede the stale self-assessment lines it answers.

An SOP is short guidance, not an archive — rewrite it in place from the full old copy; never invent a basis or submit a partial rule.

## Identity head — stable, minimal

The Identity head is machine-parsed, so keep it minimal and STABLE:
- **Never change the user's Name, how to address them, or their pronouns unless the user explicitly asks.** A name change is a user correction — you do not infer it. If the card already has a Name, preserve it exactly.
- **Spelling and casing variants are NOT alternate names.** Never add "(also written …)" / "又称 …" annotations inside any Identity field — those corrupt the machine-parsed value.
- A genuine alias/nickname (a name the user actually goes by, distinct from their name) goes in \`setIdentity("alias", …)\`.

## Ref entry format

Every claim carries refs to its evidence slice — cite the slice id exactly as shown: \`["2026-08-07-0709"]\` (slice) or \`["2026-08-07-0709-abc123"]\` (slice-turn). Never invent refs — no evidence, no write.

## Reformat (legacy only)

Older formats are historical material. Reuse independently supported biographical facts, treat old inferences as interpretations, and leave operational notes and legacy commitments with their own subject. Preserve the user's original meaning and dates.

## Your Process

1. Read the time context + compare the conversation against the card and the direction. New durable info? Stale lines? Evidence for/against a hypothesis?
2. Evaluate which view, if either, the evidence changes. Check original utterances with readSlice when needed and apply only the relevant mutations.
4. \`finish\` LAST — 1-3 sentences of reasoning (developer log) + a one-sentence user-language summary of what changed (shown in the UI; empty when nothing changed) + \`directionSummary\` when the direction moved. Never write after finish.

**Semantic merging:** the same concept across languages (e.g. "self-evolution" and "自我进化") is ONE fact — merge, never duplicate.`;

/** Fully static system prompt — one shared prefix-cache entry across calls. */
const PREVIOUSLY_SYSTEM = buildSubAgentSystem(`${PREVIOUSLY_ROLE}\n\n${RECORD_ATTRIBUTION_RULE}`);

function buildTimeContext(input: PreviouslyAgentInput): string {
  const doc = input.previouslyContent.trim()
    ? parseCard(input.previouslyContent)
    : null;
  const today =
    input.todayLocal ??
    doc?.now.find((r) => r.since)?.since ??
    new Date().toISOString().slice(0, 10);
  const lines: string[] = [`**Today (the user's LOCAL date): ${today}**`];
  if (doc) {
    const aged = doc.now
      .map((r) => ({ text: r.text, since: r.since, days: daysBetween(r.since, today) }))
      .filter((r) => r.days >= CARD_NOW_EXPIRY_DAYS);
    if (aged.length > 0) {
      lines.push(
        `Now items PAST the ${CARD_NOW_EXPIRY_DAYS}-day horizon (you decide: promote durable substance to Past, or remove the hook):`,
      );
      for (const r of aged) lines.push(`- ${r.days} days old (since ${r.since}): "${r.text.slice(0, 80)}"`);
    }
  }
  return lines.join("\n");
}

function daysBetween(since: string, today: string): number {
  const a = Date.parse(`${since}T00:00:00.000Z`);
  const b = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/** The direction-evaluation section of the user prompt (merged run only). */
function buildDirectionEvalSection(evalInput: DirectionEvalInput): string {
  const modeLine =
    evalInput.mode === "bootstrap"
      ? "BOOTSTRAP — the direction has never been written. Empty dimensions are expected."
      : evalInput.mode === "migrate"
        ? "MIGRATE — review the older structure and carry forward only statements supported at their own evidence level."
        : "steady — revise individual claims as evidence warrants";
  return `

## Direction evaluation (alongside the retrospective card)

Mode: ${modeLine}

### Current direction.md

${evalInput.current?.trim() || "(not set yet — this would be the FIRST direction)"}

### Legacy Self-model notes (historical, with mixed subjects)

${evalInput.cardSelfModel?.trim() || "(none — the card carries no legacy Self-model lines)"}

### Recent closed-slice markings (newest ${evalInput.recentMarkings?.length ?? 0})

${renderDirectionMarkings(evalInput.recentMarkings)}

### This slice's analysis

${renderDirectionAnalysis(evalInput.analysis)}

Consider each claim independently. Unchanged is a complete outcome. The case record, the retrospective card and Direction can change separately.`;
}

/** The dynamic USER prompt: time context, signal, current card, conversation. */
function buildUserPrompt(input: PreviouslyAgentInput): string {
  const {
    signal, note, currentSliceId, closedSliceId, previouslyContent,
    recentTurns,
  } = input;

  const signalLabels: Record<PreviouslySignal, string> = {
    new_observation: "new_observation — a new round of conversation happened; check for new information",
    slice_closed: "slice_closed — a time slice just closed; review the whole conversation",
    field_report: "field_report — a field report arrived about a slice that is still open; review what it points to, the slice has NOT closed",
    self_reflection: "self_reflection — the core agent thinks its strategy needs adjustment",
  };

  const deepNote = closedSliceId
    ? `\n**DEEP MODE**: slice \`${closedSliceId}\` just closed. Its conversation excerpt is below; its agent timeline (readAgentTimeline) is your process context.`
    : "";

  // The direction rides the prompt two ways: the merged run's EVALUATION
  // section (the agent judges + may propose), or — on the explicit-request
  // path — the orientation-only CRITERIA block.
  const directionSection = input.directionEval
    ? buildDirectionEvalSection(input.directionEval)
    : input.direction?.trim()
      ? `

## Evolution direction (interpretations for context)

${input.direction.trim()}`
      : "";

  const allowedSops = input.allowedSopWrites ?? [];
  const sopWorkingCopies = allowedSops.map((agent) => {
    const snapshot = input.sopSnapshots?.[agent];
    if (!snapshot) {
      return `### ${agent} — READ UNAVAILABLE\n\n(no recorded full read; writeSop will be rejected)`;
    }
    return `### ${agent} — effective origin: ${snapshot.origin}\n\n${snapshot.content ?? "(missing on both the new and legacy roots; the working copy is empty)"}`;
  }).join("\n\n");
  const sopSection =
    allowedSops.length > 0
      ? `

## self/ SOPs writable this run

These colleagues' SOPs may be rewritten from this slice's evidence: ${allowedSops.join(", ")}. A write cites the source slices, expected benefit and applicability, and uses the complete working copy. Keep implementation commentary out of the case.

### Complete old working copies (the only recorded write bases)

${sopWorkingCopies}

Preserve unrelated still-valid rules. The staged write carries the recorded revision; engineering compares it with fresh effective state and rejects a stale overwrite.`
      : "";

  const profileSection = input.userProfile?.trim()
    ? `

## User's self-description (people/user/profile.md — written by the user, NEVER by you)

${input.userProfile.trim()}

On any conflict with the model you maintain, THE SELF-DESCRIPTION WINS — fold your model toward it.`
    : "";

  return `## Time context

${buildTimeContext(input)}

## Signal

${signalLabels[signal]}
Note: "${note}"
Current slice: \`${currentSliceId}\`${deepNote}${directionSection}${sopSection}${profileSection}

${projectLivePreviously(previouslyContent) === previouslyContent ? "## Current card" : "## Legacy source for review — original wording. Only supported current material belongs in the live views."}

${previouslyContent || "(empty card — leave it empty unless a fact warrants a place in the user's continuing story.)"}

## Recent Conversation (your window into what changed)

${recentTurns.length > 0
  ? renderAttributedTurns(recentTurns)
  : "(No recent conversation provided.)"}`;
}

// ─── Tools ────────────────────────────────────────────────────────────────

/**
 * The per-attempt working copy of direction.md (merged run only): the agent
 * edits it through the direction MUTATION tools — one targeted op at a time,
 * each validated on apply, `proposed` pointers code-stamped — exactly the
 * card's session discipline, never a whole-doc rewrite.
 */
export interface DirectionSession {
  doc: string;
  touched: boolean;
  log: string[];
}

const attributedRecord = z.object({
  source: z.object({ ref: z.string(), kind: z.literal("conversation_record") }),
  turns: z.array(z.object({
    role: z.string(), sourceRole: z.string(), boundary: z.string().optional(),
    content: z.string(), turnId: z.string().optional(),
  })),
});

function buildTools(
  input: PreviouslyAgentInput,
  session: CardSession,
  sopWrites: SopWrite[],
  directionSession: DirectionSession | null,
) {
  // Only original, attributed user passages can support a new confirmed entry.
  const userPassages = new Map<string, Array<{ content: string; turnId?: string }>>();
  const rememberPassages = (sliceId: string, turns: PreviouslyAgentInput["recentTurns"]) => {
    const passages = userPassages.get(sliceId) ?? [];
    for (const turn of turns) {
      if (turn.role === "user" && turn.content.trim()) passages.push(turn);
    }
    userPassages.set(sliceId, passages);
  };
  rememberPassages(input.currentSliceId, input.recentTurns);

  const applyDirOp = (op: DirectionOp, selfDescription?: string): string => {
    if (!directionSession) {
      return "REJECTED — this run carries no direction evaluation.";
    }
    if ("refs" in op) {
      const situations = new Set<string>();
      let quoted = false;
      for (const ref of op.refs) {
        const sliceId = canonicalScenarioFromRef(ref);
        if (!sliceId) return "REJECTED — cite a valid slice or slice-turn id.";
        const turnId = ref.trim().replace(/^records\//, "").slice(sliceId.length + 1);
        const passages = userPassages.get(sliceId)?.filter(turn => !turnId || turn.turnId === turnId);
        if (!passages?.length) return "REJECTED — read the original user passage for each cited record before updating the portrait.";
        situations.add(sliceId);
        if (selfDescription?.trim() && passages.some(turn => turn.content.includes(selfDescription.trim()))) quoted = true;
      }
      if (selfDescription && !quoted) return "REJECTED — copy the user's explicit self-description from a cited passage.";
      if (situations.size < 2 && !quoted) return "REJECTED — a single situation can support a tentative hypothesis. A confirmed entry needs independent situations or the user's explicit self-description, quoted in selfDescription.";
    }
    if (op.op === "add_hypothesis" && !userPassages.get(input.currentSliceId)?.length)
      return "REJECTED — read the originating user evidence for this hypothesis.";
    const r = applyDirectionOps(directionSession.doc, [op], {
      sliceId: input.currentSliceId,
    });
    const res = r.results[0];
    if (res.ok) {
      directionSession.doc = r.doc;
      directionSession.touched = true;
      directionSession.log.push(`${op.op}: ${res.detail.slice(0, 120)}`);
      return `OK — ${res.detail}`;
    }
    return `REJECTED — ${res.detail}`;
  };
  const DIMENSIONS_ENUM = [
    "## Traits & cognitive style",
    "## Triggers & rhythms",
    "## Patterns & loops",
    "## Strengths & resilience",
    "## Communication preferences",
    "## Values & boundaries",
  ] as const;
  const selfDescription = z.string().trim().min(1).optional().describe("With one source, quote the user's explicit self-description verbatim. Keep its scope and meaning; inferred purposes or explanations need independent evidence.");
  const directionTools: Record<string, Tool> = directionSession
    ? {
        addPortraitEntry: tool({
          description:
            "Add a CONFIRMED portrait entry to one of the six fixed dimensions — " +
            "descriptive, portrait-grade (holds across contexts, outlives its evidence, " +
            "predicts), NEVER imperative, no names/dates/events in the text; evidence " +
            "rides the refs array (≥1 slice id).",
          inputSchema: z.object({
            dimension: z.enum(DIMENSIONS_ENUM),
            text: z.string(),
            refs: z.array(z.string()).describe("Original slices read for this claim. Repeated accounts of one experience are one situation."),
            selfDescription,
          }),
          execute: async ({ dimension, text, refs, selfDescription }) =>
            applyDirOp({ op: "add_portrait", dimension, text, refs }, selfDescription),
        }),
        updatePortraitEntry: tool({
          description:
            "Replace ONE existing Portrait line (matched by a substring of its text) " +
            "with a refined entry — same payload discipline as addPortraitEntry.",
          inputSchema: z.object({
            match: z.string().describe("A substring of the ONE existing line to replace."),
            text: z.string(),
            refs: z.array(z.string()),
            selfDescription,
          }),
          execute: async ({ match, text, refs, selfDescription }) =>
            applyDirOp({ op: "update_portrait", match, text, refs }, selfDescription),
        }),
        removePortraitEntry: tool({
          description:
            "Remove ONE existing Portrait line (matched by a substring) — reversal is " +
            "legal: when the user changes, a stale portrait entry SHOULD retire.",
          inputSchema: z.object({
            match: z.string().describe("A substring of the ONE existing line to remove."),
          }),
          execute: async ({ match }) => applyDirOp({ op: "remove_portrait", match }),
        }),
        addHypothesis: tool({
          description:
            "Add a GUESS about the user's traits/patterns to the hypothesis pool " +
            "(maximum 10, no minimum). Engineering stamps the " +
            "[proposed <slice>] pointer; you supply the guess + its falsification " +
            "condition. Guesses are about the PERSON, never event predictions.",
          inputSchema: z.object({
            text: z.string().describe("A conditional expectation grounded in something the user actually noticed, chose or did. Reporting a group decision does not establish that they made it. Omit slice ids."),
            falsify: z.string().describe("An observation where the proposed condition holds but the expected response differs. Observing the person when the condition is absent cannot test it."),
          }),
          execute: async ({ text, falsify }) =>
            applyDirOp({ op: "add_hypothesis", text, falsify }),
        }),
        promoteHypothesis: tool({
          description:
            "Promote ONE CONFIRMED hypothesis (≥2 distinct slices' evidence, or " +
            "explicit user confirmation) into a Portrait dimension — the guess leaves " +
            " the pool IN THE SAME RUN, re-phrased portrait-grade with its refs.",
          inputSchema: z.object({
            match: z.string().describe("A substring of the ONE confirmed hypothesis line."),
            dimension: z.enum(DIMENSIONS_ENUM),
            text: z.string().describe("The portrait-grade re-phrasing."),
            refs: z.array(z.string()),
            selfDescription,
          }),
          execute: async ({ match, dimension, text, refs, selfDescription }) =>
            applyDirOp({ op: "promote_hypothesis", match, dimension, text, refs }, selfDescription),
        }),
        removeHypothesis: tool({
          description:
            "Remove ONE refuted hypothesis (matched by a substring). Expiry needs no " +
            "call — engineering retires over-age guesses deterministically.",
          inputSchema: z.object({
            match: z.string().describe("A substring of the ONE refuted hypothesis line."),
          }),
          execute: async ({ match }) => applyDirOp({ op: "remove_hypothesis", match }),
        }),
      }
    : {};
  return {
    // ── Write tools (mutations on the session's working document) ──
    setIdentity: tool({
      description:
        "Set or replace one Identity head field. Name/pronouns/address-as are STABLE — " +
        "change them only when the user explicitly asked.",
      inputSchema: z.object({
        field: z.enum(["name", "address_as", "pronouns", "alias"]),
        value: z.string().describe("The field value, e.g. 'Alan'. Single line."),
      }),
      execute: async ({ field, value }) => sessionSetIdentity(session, field, value),
    }),
    updatePastProfile: tool({
      description:
        `Rewrite the rolling Past profile paragraph IN PLACE (≤ ${CARD_PROFILE_MAX_CHARS} chars). ` +
        "Keep established background or turning points that help a reader pick up the user's story. A single observation can remain in its case.",
      inputSchema: z.object({
        text: z.string().describe("The full new profile paragraph, in the user's language."),
      }),
      execute: async ({ text }) => sessionUpdatePastProfile(session, text),
    }),
    addPastAnchor: tool({
      description:
        `Add a durable Past anchor fact (≤ ${PAST_ANCHOR_MAX_CHARS} chars, refs required, ≤ ${PAST_ANCHORS_MAX} total). ` +
        "An anchor is an established fact of lasting relevance to the user's story.",
      inputSchema: z.object({
        text: z.string(),
        refs: z.array(z.string()).describe("Evidence slice ids, e.g. [\"2026-08-07-0709\"]."),
      }),
      execute: async ({ text, refs }) => sessionAddPastAnchor(session, text, refs),
    }),
    removePastAnchor: tool({
      description: "Remove a Past anchor by a substring of its text.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionRemovePastAnchor(session, match),
    }),
    addNow: tool({
      description:
        `Add a Now hook — a current situation that will fade (≤ ${NOW_ITEM_MAX_CHARS} chars, refs required, ≤ ${CARD_NOW_MAX} total). ` +
        "ONE event per line; the details stay in the slices.",
      inputSchema: z.object({
        text: z.string(),
        refs: z.array(z.string()),
        since: z.string().optional().describe("YYYY-MM-DD, defaults to the user's local today."),
      }),
      execute: async ({ text, refs, since }) => sessionAddNow(session, text, refs, since),
    }),
    removeNow: tool({
      description: "Remove a Now item by a substring of its text.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionRemoveNow(session, match),
    }),
    promoteNowToPast: tool({
      description:
        "Promote a Now item to a durable Past anchor, keeping its refs. " +
        "Use when a fading situation turned out to be lasting.",
      inputSchema: z.object({ match: z.string() }),
      execute: async ({ match }) => sessionPromoteNowToPast(session, match),
    }),
    // ── SOP mutation (v0.19 §C.2 — the evolution agent is the single writer
    // of card / direction / self/ SOPs; the write lands on an in-memory list
    // here and is persisted by the caller next to the card write-back) ──
    writeSop: tool({
      description:
        "Rewrite a self/ colleague's SOP from the COMPLETE old working copy in the task — " +
        "agent ∈ search / thinkdeep. The allowlist and recorded read basis are hard gates. " +
        "Evidence, expected benefit, and applicability must all be nonempty. The caller " +
        "compares the recorded revision with fresh effective state; a stale write is rejected. " +
        "The prose reads as a dated investigator's account, never builder vocabulary " +
        "(工程侧 / 代码 / 实现 / 缺陷 / 修复 / 上报) or notes addressed to the agent's makers.",
      inputSchema: z.object({
        agent: z.enum(["search", "thinkdeep"]),
        content: z
          .string()
          .describe("The FULL proposed SOP, preserving unrelated still-valid rules from the recorded old copy."),
        evidence: z
          .array(z.string())
          .min(1)
          .describe("Nonempty record slice pointers backing this change."),
        expectedBenefit: z
          .string()
          .describe("Nonempty expected improvement to check later; not verified improvement."),
        applicability: z
          .string()
          .describe("Nonempty statement of exactly when this SOP applies."),
      }),
      execute: async ({ agent, content, evidence, expectedBenefit, applicability }) => {
        const allowed = input.allowedSopWrites ?? [];
        if (!allowed.includes(agent)) {
          return (
            `REJECTED — the "${agent}" SOP is not writable this run ` +
            `(allowed: ${allowed.join(", ") || "none"}). SOP writes land ` +
            "through HQ / an evolution run, not this one; leave the SOP as it is."
          );
        }
        const readBasis = input.sopSnapshots?.[agent];
        if (!readBasis) {
          return `REJECTED — no recorded full read basis for the ${agent} SOP.`;
        }
        if (!content.trim()) return "REJECTED — SOP content is empty.";
        const cleanEvidence = evidence.map((item) => item.trim()).filter(Boolean);
        if (cleanEvidence.length === 0) return "REJECTED — SOP evidence is empty.";
        const invalidEvidence = cleanEvidence.find((ref) => canonicalScenarioFromRef(ref) === null);
        if (invalidEvidence) {
          return `REJECTED — SOP evidence "${invalidEvidence}" is not a valid canonical slice or slice-turn ref.`;
        }
        if (!expectedBenefit.trim()) return "REJECTED — SOP expectedBenefit is empty.";
        if (!applicability.trim()) return "REJECTED — SOP applicability is empty.";
        const trimmed = content.trim();
        const existingIdx = sopWrites.findIndex((w) => w.agent === agent);
        const write: SopWrite = {
          agent,
          content: trimmed,
          evidence: cleanEvidence,
          expectedBenefit: expectedBenefit.trim(),
          applicability: applicability.trim(),
          baseRevision: readBasis.revision,
        };
        if (existingIdx >= 0) sopWrites.splice(existingIdx, 1, write);
        else sopWrites.push(write);
        return (
          `OK — ${agent} SOP staged from the recorded read (${trimmed.length} chars). ` +
          "The caller must still accept the fresh revision comparison."
        );
      },
    }),
    // ── Direction mutations (merged run only — the direction half edits its
    // own working copy through these, same session discipline as the card) ──
    ...directionTools,
    // ── Read tools ──────────────────────────────────────────────────
    readSlice: tool({
      description:
        "Read the conversation record (core.md) from a specific slice. " +
        "Use this to verify what the user actually said, or to explore a closed slice. " +
        "Use the optional range parameter to fetch only recent turns.",
      inputSchema: z.object({
        sliceId: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format."),
        range: z.object({
          type: z.enum(["turns", "last", "date"]).describe(
            "turns = specific turn indices. last = most recent N. date = after a timestamp.",
          ),
          indices: z.array(z.number()).optional().describe("For type 'turns'."),
          count: z.number().optional().describe("For type 'last'."),
          after: z.string().optional().describe("ISO 8601 timestamp. For type 'date'."),
        }).optional().describe("Optional range filter."),
      }),
      execute: async ({ sliceId, range }) => {
        try {
          const result = await input.readSliceFn(sliceId, range);
          if (directionSession) {
            try {
              const record = attributedRecord.safeParse(JSON.parse(result));
              if (record.success && record.data.source.ref === `records/${sliceId}`) {
                rememberPassages(sliceId, record.data.turns.filter(turn => turn.sourceRole === "user" && turn.boundary !== "ambiguous"));
              }
            } catch { /* Historical readers can return plain diagnostics without a source receipt. */ }
          }
          return result;
        } catch { return `(slice not found: ${sliceId})`; }
      },
    }),
    readAgentTimeline: tool({
      description:
        "Read agent.md for a specific slice — the agent's reasoning and tool calls. " +
        "Process context for judging how interactions went. " +
        "Never take user FACTS from here — facts come from the conversation.",
      inputSchema: z.object({
        sliceId: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format."),
      }),
      execute: async ({ sliceId }) => {
        try { return await input.readAgentTimelineFn(sliceId); }
        catch { return `(agent.md not available for ${sliceId})`; }
      },
    }),
    readPreviously: tool({
      description:
        "Read previously.md from a specific past slice. " +
        "This historical, derived account can orient a read of the original conversation.",
      inputSchema: z.object({
        sliceId: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format."),
      }),
      execute: async ({ sliceId }) => {
        try { return await input.readPreviouslyFn(sliceId); }
        catch { return `(previously.md not available for ${sliceId})`; }
      },
    }),
    // ── Terminal (the report tool — the runner extracts + validates it) ──
    finish: tool({
      description:
        "REQUIRED — call this LAST to end the pass. `reasoning`: 1-3 sentences for the " +
        "developer log. `summary`: ONE short sentence IN THE USER'S LANGUAGE describing " +
        "what this evolution changed (shown to the user and the core agent) — empty string " +
        "when nothing changed. `expectedBenefit`: one line on what improves for the user — " +
        "archived with the mutation record. `directionSummary`: one line on what changed " +
        "in direction.md — ONLY when you moved the direction with the direction tools " +
        "(the common case is omitting it). Call finish even when nothing changed.",
      inputSchema: z.object({
        reasoning: z.string().describe("1-3 sentences for the developer log."),
        summary: z
          .string()
          .describe(
            "One short sentence in the user's language describing what changed, e.g. " +
            "'Noted your Friday interview and marked waiting-on-HR as in progress' " +
            "(match the USER's language, not this example's). Empty when nothing changed.",
          ),
        expectedBenefit: z
          .string()
          .optional()
          .describe(
            "One line: what improves for the user if this change holds (archived with the " +
            "mutation record, design: every mutation carries its expected benefit).",
          ),
        directionSummary: z
          .string()
          .optional()
          .describe(
            "One line: what changed in the direction (promotions / new guesses / retirements). " +
            "Omit when the direction stayed as it is.",
          ),
      }),
    }),
  };
}

// ─── Runner call ──────────────────────────────────────────────────────────

/** The run does BOTH domains (direction + card/SOPs) — the cap is an
 *  anti-loop fuse, generous by design (there is no wall-clock budget:
 *  v0.34 修订 A deleted execution budgets repo-wide). */
const MAX_STEPS = 50;

const finishReportSchema = z.object({
  reasoning: z.string(),
  summary: z.string().catch(""),
  expectedBenefit: z.string().catch("").optional(),
  directionSummary: z.string().catch("").optional(),
});

interface AttemptOutcome {
  reasoning: string;
  summary: string;
  expectedBenefit?: string;
  directionSummary?: string;
  failed?: boolean;
  partial?: boolean;
}

async function attemptCall(
  input: PreviouslyAgentInput,
  session: CardSession,
  sopWrites: SopWrite[],
  directionSession: DirectionSession | null,
): Promise<AttemptOutcome> {
  const res = await runSubAgent<{
    reasoning: string;
    summary: string;
    expectedBenefit?: string;
    directionSummary?: string;
  }>({
    model: input.model,
    sessionId: input.currentSliceId,
    system: PREVIOUSLY_SYSTEM,
    prompt: buildUserPrompt(input),
    tools: buildTools(input, session, sopWrites, directionSession),
    reportToolName: "finish",
    reportSchema: finishReportSchema,
    maxSteps: MAX_STEPS,
    role: "summary",
    onLine: input.onLine,
  });

  if (res.ok && res.report) {
    return {
      reasoning: res.report.reasoning,
      summary: res.report.summary,
      ...(res.report.expectedBenefit?.trim()
        ? { expectedBenefit: res.report.expectedBenefit.trim() }
        : {}),
      ...(input.directionEval && res.report.directionSummary?.trim()
        ? { directionSummary: res.report.directionSummary.trim() }
        : {}),
    };
  }
  if (res.ok) {
    // Step limit reached without finish (or a plain-text stop / unparseable
    // finish call): the mutations that already landed are still valid work —
    // return the card as it stands, flagged partial, instead of failing.
    if (res.text.trim())
      console.warn("[PreviouslyAgent] Agent produced text instead of finish:", res.text.slice(0, 200));
    return { reasoning: "step limit reached without finish", summary: "", partial: true };
  }
  return { reasoning: res.error ?? "Previously Agent failed", summary: "", failed: true };
}

const RETRY_DELAY_MS = 300;

async function attempt(
  input: PreviouslyAgentInput,
  today: string,
): Promise<PreviouslyAgentOutput> {
  // A fresh session per attempt — a retried pass never inherits half-applied
  // mutations. The staged SOP writes and the direction working copy are
  // likewise per-attempt.
  const session = createCardSession(
    projectLivePreviously(input.previouslyContent),
    input.currentSliceId,
    today,
  );
  const sopWrites: SopWrite[] = [];
  const directionSession: DirectionSession | null = input.directionEval
    ? {
        // Steady mode edits the on-disk doc; bootstrap/migrate BUILD the new
        // skeleton from scratch (the old doc is evidence in the prompt, not
        // the working copy — its stale sections must not survive the ops).
        doc:
          input.directionEval.mode === "steady" &&
          input.directionEval.current?.trim()
            ? input.directionEval.current.trim()
            : emptyDirectionDoc(),
        touched: false,
        log: [],
      }
    : null;
  const r = await attemptCall(input, session, sopWrites, directionSession);
  const failed = r.failed === true;
  // The direction moved when the working copy differs from the on-disk doc.
  const directionChanged =
    directionSession !== null &&
    directionSession.touched &&
    directionSession.doc.trim() !== (input.directionEval?.current?.trim() ?? "");
  return {
    updatedCard: failed ? "" : (session.log.length || !input.previouslyContent ? serializeSession(session) : input.previouslyContent),
    reasoning: r.reasoning,
    summary: r.summary,
    mutations: session.log,
    failed: failed || undefined,
    partial: r.partial,
    // Playbook writes stage independently of the card's finish state: a
    // partial pass may still have landed a valid SOP mutation.
    ...(sopWrites.length > 0 && !failed ? { sopWrites } : {}),
    ...(r.expectedBenefit ? { expectedBenefit: r.expectedBenefit } : {}),
    // Direction ops likewise land per-attempt; a partial pass may still have
    // moved the direction. The caller runs the whole-doc gate + TTL.
    ...(directionChanged && !failed
      ? {
          direction: {
            doc: directionSession.doc,
            checkedMutations: true as const,
            summary: r.directionSummary ?? "",
          },
        }
      : {}),
  };
}

/**
 * Run the Previously Agent. Never throws.
 *   - clean finish          → the serialized card;
 *   - step limit w/o finish → the serialized card flagged `partial` (the
 *     loop brake force-lands repeated length violations, so partial work is
 *     bounded and sane) — the caller writes it back with a partial note;
 *   - hard failure          → ONE retry with a fresh session. Still
 *     failing → empty card + `failed`, so the caller can no-op gracefully.
 */
export async function runPreviouslyAgent(
  input: PreviouslyAgentInput,
): Promise<PreviouslyAgentOutput> {
  const today = input.todayLocal ?? new Date().toISOString().slice(0, 10);
  const first = await attempt(input, today);
  if (!first.failed) return first;
  console.warn(
    "[PreviouslyAgent] First attempt failed, retrying with a fresh session:",
    first.reasoning,
  );
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  const second = await attempt(input, today);
  if (!second.failed) return second;
  return {
    updatedCard: "",
    reasoning: second.reasoning || "Previously Agent worker unavailable",
    summary: "",
    mutations: [],
    failed: true,
  };
}
