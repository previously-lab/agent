/**
 * Phase-level bridge outsourcing (client mode + bridge brain).
 *
 * Instead of letting each housekeeping sub-agent (turn-analyzer, Previously
 * Agent, …) resolve to the bridge model and spawn its own CLI subprocess, the
 * WHOLE housekeeping phase is outsourced as ONE bridge call: the client agent
 * returns a single structured JSON report (turn analysis + closed-slice
 * marking + card-evolution decision with mutation proposals); the kernel
 * validates it (zod + the existing card-session caps) and applies it through
 * the same downstream code paths as the sub-agent flow.
 *
 * The contract is exactly what the sole caller (housekeeping in
 * src/app/api/chat/steps.ts) can feed: message, recent turns, the card, the
 * closing slice. The former jobs 4-7 (dry-slice backfill, strand merge, the
 * Phase-1 direction verdict, SOP evolution) were removed from the prompt and
 * the report schema (review F3, 2026-10-12): their payload sections were
 * never injected — the caller passes none of those inputs — so the report
 * fields backfill_marks / strand_merges / direction / playbooks were
 * structurally always empty. Old clients still sending those keys (or the
 * long-retired fitness array) are tolerated: zod strips unknown keys.
 *
 * Wire contract (shared with the client repo — do not deviate):
 *   stdin : { task, context, phase: "housekeeping", protocol: 2 }
 *   stdout: the agent's final reply is EXACTLY one JSON object matching
 *           housekeepingPhaseReportSchema (stray prose around it is tolerated
 *           at extraction, never at validation).
 *
 * runHousekeepingBridge runs INSIDE the housekeeping step's invocation (same
 * as analyzeTurn / runCardEvolution, which also carry no "use step" of their
 * own) — the `"use step"` boundary stays on housekeeping() in
 * src/app/api/chat/steps.ts, because the withWorkflow loader only compiles
 * directives under src/app.
 *
 * Every failure (bridge error, malformed JSON, schema mismatch) comes back as
 * { ok: false, reason } — this module never throws (mirrors the analyzer's
 * never-throw degradation contract).
 */
import { z } from "zod";
import { DOC_HOUSE_STYLE, DOC_LANGUAGE_RULE } from "@/lib/agents/doc-style";
import {
  getBridgeCommand,
  getBridgeTimeoutMs,
  runBridge,
  splitBridgeCommand,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEvent,
} from "@/lib/bridge";
import {
  createCardSession,
  serializeSession,
  sameCardSubstance,
  sessionAddHorizon,
  sessionAddNow,
  sessionAddPastAnchor,
  sessionPromoteNowToPast,
  sessionRemoveNow,
  sessionRemovePastAnchor,
  sessionResolveHorizon,
  sessionSetIdentity,
  sessionUpdatePastProfile,
  type CardSession,
  type IdentityField,
} from "@/lib/episodic/card-session";
import { parseCard } from "@/lib/episodic/previously-format";
import {
  diffCardLines,
  summarizeCardChanges,
} from "@/lib/episodic/card-diff";
import {
  writePreviously,
} from "@/lib/episodic";
import type { WriteBatch } from "@/lib/episodic/io-helpers";
import type { TurnAnalysis, TurnIntent } from "@/lib/episodic/flash/turn-analyzer";
import type { EmotionalTone } from "@/lib/episodic/types";
import type { EvolutionResult } from "@/lib/chat/turn-types";
import {
  readUserModel,
  writeUserModelCard,
} from "@/lib/evolution/store";

// ─── Gate ──────────────────────────────────────────────────────────────────

/**
 * Is phase-level outsourcing active? The turn's model actually running on the
 * bridge (modelSdk) + the kill-switch env. PREVIOUSLY_PHASE_OUTSOURCE=0 falls
 * back to the old per-sub-agent path (each sub-agent its own bridge spawn).
 *
 * The gate keys on the resolved model alone, not on how the bridge engine was
 * activated (env PREVIOUSLY_BRAIN or config.json brain — either registers the
 * bridge/* models, and only then can a turn resolve to sdk "bridge"). That
 * keeps engine switching hot: no restart, in-flight calls finish on the model
 * they started with. The BYOK case is covered the same way — a byok/* model
 * has sdk "openai", so housekeeping runs the standard API sub-agent path.
 */
export function isPhaseOutsourceActive(modelSdk: string): boolean {
  return (
    modelSdk === "bridge" && process.env.PREVIOUSLY_PHASE_OUTSOURCE !== "0"
  );
}

// ─── Wire schema ───────────────────────────────────────────────────────────

/** Intent values — must stay in sync with INTENT_TYPES in turn-analyzer.ts. */
const WIRE_INTENTS = [
  "code_debug",
  "code_write",
  "explain",
  "chat",
  "review",
  "clarify",
] as const;

const cardMutationSchema = z.discriminatedUnion("op", [
  // content is one "Label: value" Identity line (Name / Address them as /
  // Pronouns / Alias) — the applier parses the label into the field.
  z.object({ op: z.literal("setIdentity"), content: z.string() }),
  z.object({ op: z.literal("updatePastProfile"), content: z.string() }),
  z.object({ op: z.literal("addPastAnchor"), content: z.string() }),
  z.object({ op: z.literal("removePastAnchor"), match: z.string() }),
  z.object({ op: z.literal("addNow"), content: z.string() }),
  z.object({ op: z.literal("removeNow"), match: z.string() }),
  z.object({ op: z.literal("promoteNowToPast"), match: z.string() }),
  z.object({
    op: z.literal("addHorizon"),
    content: z.string(),
    by: z.string().nullable().default(null),
    refs: z.array(z.string()).default([]),
  }),
  z.object({
    op: z.literal("resolveHorizon"),
    match: z.string(),
    resolution: z.string().default(""),
  }),
  z.object({
    op: z.literal("addSelfModel"),
    content: z.string(),
    evidence: z.array(z.string()).default([]),
  }),
  z.object({ op: z.literal("removeSelfModel"), match: z.string() }),
]);
export type BridgeCardMutation = z.infer<typeof cardMutationSchema>;

/** Sanity cap — a runaway mutation list is truncated, not rejected. */
const MAX_MUTATIONS = 40;

/**
 * The report schema. ONLY the fields the sole caller can act on: analysis,
 * closed_marking, evolution. The retired jobs 4-7 fields (backfill_marks /
 * strand_merges / direction / playbooks — and the even older fitness array)
 * are gone; an old client still sending them is tolerated by zod's default
 * unknown-key stripping, never rejected.
 */
export const housekeepingPhaseReportSchema = z.object({
  analysis: z.object({
    intent: z.enum(WIRE_INTENTS),
    memory_worthy: z.boolean(),
    memory_update: z.string().nullable(),
    emotional_signal: z.object({
      intensity: z.enum(["none", "light", "strong"]),
      register: z.enum([
        "neutral",
        "emotional",
        "humorous",
        "frustrated",
        "excited",
      ]),
      note: z.string(),
    }),
  }),
  closed_marking: z
    .object({
      focus: z.string(),
      summary: z.string(),
      tone: z.string(),
    })
    .nullable(),
  evolution: z.object({
    worth: z.boolean(),
    reason: z.string(),
    mutations: z.array(cardMutationSchema),
  }),
});
export type HousekeepingPhaseReport = z.infer<
  typeof housekeepingPhaseReportSchema
>;

// ─── Input + payload assembly ───────────────────────────────────────────────

export interface HousekeepingBridgeInput {
  /** The current user message. */
  userMessage: string;
  /** Recent turns of the active slice (context for analysis/evolution). */
  recentTurns: Array<{ role: string; content: string }>;
  /** Current card content (current-previously.md; may be empty). */
  cardContent: string;
  /** The slice the card currently belongs to ("pending" before creation). */
  sliceId: string;
  /** Present only when a slice is closing this turn. */
  closingSlice?: {
    sliceId: string;
    turns: Array<{ role: string; content: string }>;
  };
  /** The user's local calendar date (YYYY-MM-DD) — Now/Horizon judgments. */
  todayLocal?: string;
  /** UI locale ("zh" | "en"). */
  locale?: string;
}

/**
 * Static instruction text — the SINGLE SOURCE of the housekeeping contract.
 * The client-side docs only carry the command list and mechanism notes; the
 * full judgment rules, the input specifics, the mutation vocabulary, and the
 * output contract all live HERE and ride the payload. The closing-slice flag
 * is appended per call (see buildHousekeepingPayload).
 */
const HOUSEKEEPING_TASK = `You are running Previously's housekeeping phase — the per-turn memory bookkeeping of a personal agent. This task is the FULL contract — the judgment rules, input specifics, and output contract all live here; your workspace instruction file only lists the available commands and mechanics.

One pass, these jobs:
1. Turn analysis — intent, memory_worthy (false for trivial turns: greetings / "继续" / thanks / small talk), memory_update (ONLY on an explicit record/evolve request or an explicit behavioral correction — the exact content, else null), emotional_signal.
2. Closed-slice marking — ONLY when the context says a slice is closing: focus (one sentence), summary (≤100 chars), tone.
3. Card evolution — judge worth (when in doubt, worth: true — a wasted review is cheap, a missed evolution is permanent memory loss) and, when worth or memory_update is set, propose card mutations with the op vocabulary below. Never rewrite the whole card; entries you don't touch stay as they are.

Mutation vocabulary (the evolution.mutations array):
- {"op":"setIdentity","content":"Name: Alan"} — one Identity head line (Name / Address them as / Pronouns / Alias).
- {"op":"updatePastProfile","content":"…"} — rewrite the rolling Past profile paragraph in place.
- {"op":"addPastAnchor","content":"…"} / {"op":"removePastAnchor","match":"…"} — durable fact / remove by substring.
- {"op":"addNow","content":"…"} / {"op":"removeNow","match":"…"} / {"op":"promoteNowToPast","match":"…"} — current-state hooks.
- {"op":"addHorizon","content":"…","by":"YYYY-MM-DD"|null,"refs":["<slice-id>",…]} / {"op":"resolveHorizon","match":"…","resolution":"…"} — open loops; resolve is the only way one leaves.

The card is a PURE semantic memory pool (Identity/Past/Now/Horizon — what the user did, is doing, will do): it NEVER carries rules, lessons, or analysis. One fact, one home.

Language and style: ${DOC_LANGUAGE_RULE}

${DOC_HOUSE_STYLE}

OUTPUT CONTRACT: your final reply must be EXACTLY ONE JSON object — no prose, no markdown fence — matching this schema:
{
  "analysis": {
    "intent": "code_debug"|"code_write"|"explain"|"chat"|"review"|"clarify",
    "memory_worthy": boolean,
    "memory_update": string | null,
    "emotional_signal": { "intensity": "none"|"light"|"strong", "register": "neutral"|"emotional"|"humorous"|"frustrated"|"excited", "note": string }
  },
  "closed_marking": { "focus": string, "summary": string, "tone": string } | null,
  "evolution": { "worth": boolean, "reason": string, "mutations": [ …ops above… ] }
}
closed_marking is null when no slice is closing; mutations is [] when nothing changes. Analysis and closed_marking must be produced from the data in this payload ALONE — do not read memory for them. Reading memory is card-evolution forensics ONLY (substantiating mutations), and only through the three evidence commands the workspace allows in this phase (readslice / agentlog / card); the search-type commands (timeline / strands / slicesummary) are gated off in the housekeeping phase and will be refused.`;

/** Compress a closing slice's turns (first turn + last 10, chars capped). */
function compressTurns(turns: Array<{ role: string; content: string }>): string {
  if (turns.length === 0) return "(empty slice)";
  const pick = turns.length <= 11 ? turns : [turns[0], ...turns.slice(-10)];
  const body = pick
    .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
    .join("\n");
  return body.length > 6000 ? body.slice(-6000) : body;
}

/**
 * Assemble the bridge payload: task = static instructions + the closing flag;
 * context = all dynamic data (message, recent turns, card, closing slice).
 * Pure — exported for tests.
 */
export function buildHousekeepingPayload(input: HousekeepingBridgeInput): {
  task: string;
  context: string;
} {
  const closing = input.closingSlice;
  const task =
    HOUSEKEEPING_TASK +
    "\n\nThis turn: " +
    (closing
      ? `slice ${closing.sliceId} IS closing — closed_marking is REQUIRED and evolution must judge the whole closed slice.`
      : "no slice is closing — closed_marking MUST be null.");

  const sections: string[] = [
    `## Current user message\n\n"${input.userMessage.slice(0, 1000)}"`,
    `## Recent turns (the active slice)\n\n${
      input.recentTurns.length > 0
        ? input.recentTurns.map((t) => `**${t.role}**: ${t.content}`).join("\n\n")
        : "(none)"
    }`,
    `## Current card (current-previously.md — your mutation proposals apply to this)\n\n${
      input.cardContent.trim() || "(empty — new card)"
    }`,
    `## Time\n\nUser's local date: ${input.todayLocal ?? "(unknown)"} · locale: ${input.locale ?? "en"} · card slice: ${input.sliceId}`,
  ];
  if (closing) {
    sections.push(
      `## Closing slice ${closing.sliceId}\n\nConversation (first turn + last turns):\n${compressTurns(closing.turns)}`,
    );
  }
  return { task, context: sections.join("\n\n") };
}

// ─── Lenient JSON extraction ────────────────────────────────────────────────

/**
 * Yield the top-level balanced JSON-object substrings of `s`, in document
 * order. String-aware (quotes + escapes), so braces inside JSON strings don't
 * break the balance.
 */
function* balancedObjects(s: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      if (depth > 0) inStr = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) yield s.slice(start, i + 1);
      }
    }
  }
}

/**
 * Leniently extract the report's JSON object from the bridge reply: the LAST
 * fenced code block's content when it parses, else the last balanced
 * top-level JSON object in the text. Returns null when nothing parses —
 * validation happens separately (housekeepingPhaseReportSchema).
 *
 * Low-level helper — kept for tests. runHousekeepingBridge uses
 * extractValidatedReport, which is validation-GUIDED: an agent that emits a
 * small fenced example (e.g. one mutation op) before the real report must not
 * win over the valid report just because it parses.
 */
export function extractReportJson(raw: string): unknown | null {
  const fenced = [...raw.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)].map(
    (m) => m[1].trim(),
  );
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fenced[i]);
    } catch {
      // try the previous block
    }
  }
  const objects = [...balancedObjects(raw)];
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(objects[i]);
    } catch {
      // try the previous object
    }
  }
  return null;
}

/**
 * Validation-guided report extraction: gather EVERY parseable JSON candidate
 * (fenced blocks and bare balanced objects, each last-in-document first) and
 * return the first that passes the report schema. The report is the agent's
 * final output, so later candidates are preferred; an early fenced example
 * that parses but isn't the report no longer nukes the run.
 */
export function extractValidatedReport(
  raw: string,
): HousekeepingBridgeResult {
  const candidates: unknown[] = [];
  const fenced = [...raw.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)].map(
    (m) => m[1].trim(),
  );
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      candidates.push(JSON.parse(fenced[i]));
    } catch {
      // not JSON — skip
    }
  }
  const objects = [...balancedObjects(raw)];
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      candidates.push(JSON.parse(objects[i]));
    } catch {
      // not JSON — skip
    }
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no JSON report found in bridge output (tail: ${JSON.stringify(raw.slice(-200))})`,
    };
  }
  let firstIssues = "";
  for (const c of candidates) {
    const parsed = housekeepingPhaseReportSchema.safeParse(c);
    if (parsed.success) return { ok: true, report: parsed.data };
    if (!firstIssues) {
      firstIssues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    }
  }
  return {
    ok: false,
    reason: `report failed schema validation: ${firstIssues}`,
  };
}

// ─── The bridge call ────────────────────────────────────────────────────────

export type HousekeepingBridgeResult =
  | { ok: true; report: HousekeepingPhaseReport }
  | { ok: false; reason: string };

/**
 * Run the whole housekeeping analysis as ONE bridge call. Never throws —
 * any failure (bridge spawn/exit/timeout, unextractable JSON, schema
 * mismatch) degrades to { ok: false } so housekeeping falls back to the
 * deterministic path (memoryWorthy=true, deterministic closed
 * marking, evolution skipped).
 *
 * `opts.onEvent` / `opts.onDelta` are optional live-activity passthroughs to
 * runBridge (protocol 2): the housekeeping step forwards tool events into the
 * turn's UI stream so the user can watch the client agent work.
 */
export async function runHousekeepingBridge(
  input: HousekeepingBridgeInput,
  opts?: {
    onEvent?: (event: BridgeEvent) => void;
    onDelta?: (text: string) => void;
  },
): Promise<HousekeepingBridgeResult> {
  try {
    const { task, context } = buildHousekeepingPayload(input);
    const result = await runBridge(
      splitBridgeCommand(getBridgeCommand()),
      JSON.stringify({
        task,
        context,
        phase: "housekeeping",
        protocol: BRIDGE_PROTOCOL_VERSION,
      }),
      getBridgeTimeoutMs(),
      undefined,
      opts?.onEvent,
      opts?.onDelta,
    );
    if (result.status !== "ok") {
      return { ok: false, reason: `${result.reason}: ${result.error}` };
    }
    return extractValidatedReport(result.result);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Report → TurnAnalysis adaptation ───────────────────────────────────────

const VALID_TONES: readonly string[] = ["positive", "neutral", "negative", "mixed"];

/**
 * Map a validated wire report onto the internal TurnAnalysis shape so ALL
 * downstream housekeeping code (closed marking, degradation
 * fallbacks) runs unchanged. Mirrors analyzeTurn's defensive post-processing.
 * No evolveCard: the bridge path's card evolution applies report.evolution
 * DIRECTLY (applyBridgeCardEvolution) — nothing consumes the analyzer's
 * evolve_card gate here.
 */
export function adaptHousekeepingReport(
  report: HousekeepingPhaseReport,
  sliceClosing: boolean,
): TurnAnalysis {
  const a = report.analysis;
  const cm = report.closed_marking;
  return {
    intent: { type: a.intent as TurnIntent, reason: "" },
    memoryWorthy: a.memory_worthy,
    emotionalSignal: {
      intensity: a.emotional_signal.intensity,
      register: a.emotional_signal.register,
      note: a.emotional_signal.note,
    },
    memoryUpdate: a.memory_update ? { content: a.memory_update } : undefined,
    closedMarking: cm
      ? {
          focus: cm.focus.trim(),
          summary: cm.summary.trim(),
          tone: VALID_TONES.includes(cm.tone)
            ? (cm.tone as EmotionalTone)
            : null,
        }
      : undefined,
  };
}

/**
 * The degraded analysis for a failed bridge call — mirrors the analyzer's
 * empty-on-failure contract (memoryWorthy=true, neutral signal).
 * The caller skips card evolution entirely on bridge failure.
 */
export function degradedAnalysis(): TurnAnalysis {
  return {
    memoryWorthy: true,
    emotionalSignal: { intensity: "none", register: "neutral", note: "" },
  };
}

// ─── Card-mutation application (reuses the card-session machinery) ──────────

export interface ApplyMutationsResult {
  /** The serialized card after the mutations (unchanged-apart-from-stamps when
   *  every mutation was rejected). */
  card: string;
  /** Substance comparison vs the base card (stamps ignored). */
  changed: boolean;
  /** The session's applied-mutation log. */
  applied: string[];
  /** Mutations REJECTED by validation (caps / no-match / malformed) — skipped
   *  silently into this list, never retried, never thrown. */
  skipped: Array<{ op: string; reason: string }>;
}

const IDENTITY_LABEL_TO_FIELD: Record<string, IdentityField> = {
  name: "name",
  "address them as": "address_as",
  address_as: "address_as",
  pronouns: "pronouns",
  alias: "alias",
};

/**
 * Apply wire mutations to a card through the EXISTING card-session mutation
 * functions — same caps, same rejection semantics as the Previously Agent's
 * write tools. A rejected op lands in `skipped` (the bridge agent gets no
 * retry loop; the loop brake is unnecessary here).
 *
 * Ref discipline: the wire ops addPastAnchor / addNow carry no refs (the
 * client cites evidence in prose); the applier injects [sliceId] — the slice
 * under review — so the session's refs-required validation holds. Dash-form
 * slice ids are normalized by the session itself.
 */
export function applyCardMutations(
  baseCard: string,
  sliceId: string,
  today: string,
  mutations: BridgeCardMutation[],
): ApplyMutationsResult {
  const session: CardSession = createCardSession(baseCard, sliceId, today);
  const skipped: Array<{ op: string; reason: string }> = [];

  const run = (op: string, fn: () => string) => {
    const out = fn();
    if (!out.startsWith("OK")) {
      skipped.push({ op, reason: out.split("\n").pop()!.slice(0, 200) });
    }
  };

  for (const m of mutations.slice(0, MAX_MUTATIONS)) {
    switch (m.op) {
      case "setIdentity": {
        const ci = m.content.indexOf(":");
        const field =
          ci > 0
            ? IDENTITY_LABEL_TO_FIELD[m.content.slice(0, ci).trim().toLowerCase()]
            : undefined;
        if (!field || ci < 0) {
          skipped.push({
            op: m.op,
            reason: `content is not a "Label: value" Identity line: ${m.content.slice(0, 80)}`,
          });
          break;
        }
        run(m.op, () =>
          sessionSetIdentity(session, field, m.content.slice(ci + 1).trim()),
        );
        break;
      }
      case "updatePastProfile":
        run(m.op, () => sessionUpdatePastProfile(session, m.content));
        break;
      case "addPastAnchor":
        run(m.op, () => sessionAddPastAnchor(session, m.content, [sliceId]));
        break;
      case "removePastAnchor":
        run(m.op, () => sessionRemovePastAnchor(session, m.match));
        break;
      case "addNow":
        run(m.op, () => sessionAddNow(session, m.content, [sliceId]));
        break;
      case "removeNow":
        run(m.op, () => sessionRemoveNow(session, m.match));
        break;
      case "promoteNowToPast":
        run(m.op, () => sessionPromoteNowToPast(session, m.match));
        break;
      case "addHorizon":
        run(m.op, () =>
          sessionAddHorizon(
            session,
            m.content,
            m.by ?? "",
            m.refs.length > 0 ? m.refs : [sliceId],
          ),
        );
        break;
      case "resolveHorizon":
        run(m.op, () => sessionResolveHorizon(session, m.match, m.resolution));
        break;
      // Legacy wire ops: the card no longer carries a Self-model section.
      // The zod schema still accepts them (legacy tolerance), but the applier
      // skips them and tells the caller where the lesson actually belongs.
      case "addSelfModel":
      case "removeSelfModel":
        skipped.push({
          op: m.op,
          reason:
            "the card no longer carries a Self-model section — trait lessons belong to the direction Portrait, which the housekeeping bridge report does not carry",
        });
        break;
    }
  }

  const card = serializeSession(session);
  return {
    card,
    changed: !sameCardSubstance(parseCard(baseCard), parseCard(card)),
    applied: session.log,
    skipped,
  };
}

/** First sentence, single line, hard-capped — the slice-frontmatter summary. */
function oneSentence(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const m = flat.match(/^.*?[.!?\u3002\uff01\uff1f]/);
  return (m ? m[0] : flat).slice(0, 200);
}

/**
 * Apply the report's evolution block to the folded user model and write it
 * back — the bridge-mode counterpart of runCardEvolution's write-back: same
 * files (people/user/index.md's card half + the per-slice FULL-model
 * snapshot), same batch, same no-op skip. Returns the EvolutionResult
 * housekeeping streams/freezes.
 */
export async function applyBridgeCardEvolution(input: {
  /** Base card content (the card half of people/user/index.md). */
  card: string;
  /** The slice whose card is updated (the closed slice on a boundary). */
  sliceId: string;
  /** The user's local calendar date (YYYY-MM-DD). */
  today: string;
  /** report.evolution.reason — becomes the note / one-sentence summary. */
  reason: string;
  mutations: BridgeCardMutation[];
  batch?: WriteBatch;
}): Promise<EvolutionResult> {
  const applied = applyCardMutations(
    input.card,
    input.sliceId,
    input.today,
    input.mutations,
  );
  const note =
    input.reason +
    (applied.skipped.length > 0
      ? ` (${applied.skipped.length} mutation(s) rejected by validation)`
      : "");

  if (!applied.changed) {
    return { ran: true, changed: false, droppedRecent: 0, note };
  }

  await writeUserModelCard(applied.card, input.batch);
  // Snapshot semantics (§B.7): previously.md freezes the FULL index.md.
  const model = await readUserModel(input.batch).catch(() => null);
  if (model) {
    await writePreviously(input.sliceId, model.full, input.batch);
  } else {
    await writePreviously(input.sliceId, applied.card, input.batch);
  }

  return {
    ran: true,
    changed: true,
    droppedRecent: 0,
    note,
    summary: oneSentence(input.reason),
    mutations: diffCardLines(input.card, applied.card),
    changes: summarizeCardChanges(input.card, applied.card, 0),
  };
}
