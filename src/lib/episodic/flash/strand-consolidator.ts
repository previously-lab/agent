/**
 * Strand Consolidator — the LLM consolidation pass for the strand index.
 *
 * The deterministic layer (normalization + normalized-match merge in
 * strands.ts) catches mechanical duplicates (`Apex`/`apex`). But the model
 * itself minted semantic duplicates — typos (`陈勇超`/`陈永超`), the
 * same concept under two names (`心态`/`心态调整`), and concept families
 * (`面试评估`/`面试复盘`/`面试问题`). Those need semantic judgment, which is
 * this module's job: an LLM pass proposes a from→to merge map; the
 * engineering layer applies it (path-union + key removal) and then prunes
 * single-use stale strands.
 *
 * Runs opportunistically at slice close (see housekeeping). Since v0.9 the
 * pass runs through the shared sub-agent runner
 * (src/lib/agents/sub-agent-runner.ts) on the turn's MAIN model — thinking on
 * at low effort, static system prompt (shared base + role), dynamic strand
 * index in the user prompt. Never throws — on any failure it returns the
 * input index unchanged so housekeeping degrades gracefully.
 *
 * This module is also the ONLY writer of the strand entity layer
 * (strands/<name>.md — see strand-files.ts): natural-language strand
 * descriptions are created/refreshed here, behind a mechanical gate
 * (gateStrandDescriptionRefresh), never by the mechanical weave path.
 */
import { tool } from "ai";
import { z } from "zod";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { buildSubAgentSystem } from "@/lib/agents/prompts";
import type { ModelConfig } from "@/lib/models/registry";
import type { StrandIndex } from "@/lib/episodic/types";
import {
  applyStrandMerges,
  pruneStrands,
  slicePathToMs,
} from "@/lib/episodic/strands";
import {
  readStrandEntity,
  writeStrandEntity,
  type StrandEntity,
} from "@/lib/episodic/strand-files";
import type { WriteBatch } from "@/lib/episodic/io-helpers";

// ─── Config ────────────────────────────────────────────────────────────────

/** Below this many strands, skip the LLM pass (nothing meaningful to dedupe).
 *  Exported: the outsourced (bridge) housekeeping path applies the same gate
 *  when deciding whether to offer merge candidates to the client agent. */
export const MIN_STRANDS_FOR_LLM = 25;
/** Cap on merges the worker may propose per pass (keeps the call cheap). */
const MAX_MERGES = 30;

// ─── Structured output schema ──────────────────────────────────────────────

const consolidateSchema = z.object({
  merges: z
    .array(
      z.object({
        from: z.string().describe("The strand key to merge INTO `to` (the redundant/less-canonical name)."),
        to: z.string().describe("The strand key to keep (the canonical name). MUST already exist in the index."),
        reason: z.string().describe("One short phrase: typo | same concept | same person/entity."),
      }),
    )
    .max(MAX_MERGES)
    .describe("Near-duplicate strand keys to merge. Empty when the index is already clean."),
  reasoning: z.string().describe("1-2 sentences for the developer log."),
});

// ─── Prompt ────────────────────────────────────────────────────────────────

/**
 * Static role block — the system prompt (shared base + this) never changes
 * between calls (prefix-cache hits). The dynamic strand index goes into the
 * user prompt.
 */
const CONSOLIDATOR_SYSTEM = buildSubAgentSystem(`You are the strand-consolidation agent for a personal memory system.

A "strand" is a keyword threading through time slices (slices/YYYY/MM/DD/HHMM). The user message carries the current strand index, mapping each strand to how many slices carry it.

## Task

Find NEAR-DUPLICATE strands — the same durable concept, person, company, or topic recorded under two or more names — and propose merging them into ONE canonical key.

Merge when they clearly denote the same thing:
- Typos / alternate spellings (陈勇超 vs 陈永超)
- Same concept in two names (心态 vs 心态调整; 面试评估 vs 面试复盘)
- Same entity written differently (Apex vs apex — case variants)
- Concept + derived-subtopic that are really the same thread (plaud vs plaud策略)

DO NOT merge:
- Distinct concepts that merely share a word (公司注册 vs 公司评估)
- A broad topic with a genuinely separate subtopic you'd want to recall independently
- Keys with zero slices in common and no clear same-concept basis

## Rules

1. Every \`to\` key MUST already exist in the provided index.
2. Prefer keeping the more specific / more used / more canonical name as \`to\`.
3. Do not propose a chain (A→B and B→C in the same pass). Each merge is independent: from → to.
4. When in doubt, do NOT merge. Precision over recall — a wrong merge destroys thread history.
5. Empty merges is a valid answer when the index is already clean.

## Output

Call \`consolidateOutput\` with your merge map (or empty) + a short reasoning note.`);

/** The dynamic user prompt: the current strand index. */
function buildPrompt(strands: StrandIndex): string {
  const rows = Object.entries(strands)
    .map(([key, paths]) => `- ${key} (${paths.length} slice${paths.length === 1 ? "" : "s"})`)
    .join("\n");

  return `## Current strand index

${rows}

Propose the merge map per your instructions.`;
}

// ─── Sub-agent call ────────────────────────────────────────────────────────

async function proposeMerges(
  model: ModelConfig,
  strands: StrandIndex,
): Promise<Array<{ from: string; to: string }>> {
  const result = await runSubAgent({
    model,
    system: CONSOLIDATOR_SYSTEM,
    prompt: buildPrompt(strands),
    temperature: 0,
    maxSteps: 50,
    timeoutMs: 30_000,
    tools: {
      consolidateOutput: tool({
        description: "Report the strand merge map.",
        inputSchema: consolidateSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "consolidateOutput",
    reportSchema: consolidateSchema,
    progress: { toolName: "strand-consolidator" },
  });

  // The runner never throws: a timeout / model failure / missing or invalid
  // report all degrade to an empty merge map.
  if (!result.ok || !result.report) return [];

  // Sanitize: drop any proposal whose `to` key doesn't exist or that is a no-op.
  return result.report.merges.filter(
    (m) => m.from !== m.to && strands[m.to] !== undefined,
  );
}

// ─── Public entry ──────────────────────────────────────────────────────────

export interface ConsolidationResult {
  strands: StrandIndex;
  pruned: string[];
  merges: Array<{ from: string; to: string }>;
  llmPassSkipped: boolean;
}

/**
 * Consolidate a strand index: deterministic pruning always runs; the LLM
 * merge pass runs only when the index is large enough to be worth it.
 * Returns the consolidated index + what was merged/pruned.
 */
export async function consolidateStrands(
  strands: StrandIndex,
  model: ModelConfig,
): Promise<ConsolidationResult> {
  // ── 1. Deterministic pruning first (cheap, always safe) ─────────────
  const { strands: afterPrune, pruned } = pruneStrands(strands);

  // ── 2. LLM merge pass (only when big enough to matter) ──────────────
  let merges: Array<{ from: string; to: string }> = [];
  let llmPassSkipped = false;
  if (Object.keys(afterPrune).length < MIN_STRANDS_FOR_LLM) {
    llmPassSkipped = true;
  } else {
    try {
      merges = await proposeMerges(model, afterPrune);
      if (merges.length > 0) {
        applyStrandMerges(afterPrune, merges);
      }
    } catch {
      // Worker unavailable — return the pruned index as-is.
      merges = [];
    }
  }

  return { strands: afterPrune, pruned, merges, llmPassSkipped };
}

// ─── Strand entity descriptions (strands/<name>.md) ───────────────────────
//
// The consolidator is the ONLY writer of strand descriptions. Two mechanical
// gates keep the LLM pass honest (and cheap), and the update call itself
// REQUIRES the slice ids that triggered it as evidence — a description may
// never be minted or refreshed without new slice backing.

/** A strand must have gained at least this many new associated slices since
 *  its last description refresh before a refresh is allowed. */
export const MIN_NEW_SLICES_FOR_DESCRIPTION = 5;
/** The same strand may not have its description refreshed more than once
 *  per this window (anchored at its last_active date). */
export const STRAND_DESCRIPTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap on LLM description refreshes per consolidation pass. */
const MAX_DESCRIPTION_REFRESHES_PER_PASS = 10;

/** "2026/08/02/0952" → "2026-08-02-0952" (the slice id form recall cites). */
function slicePathToId(path: string): string {
  return path.replace(/\//g, "-");
}

/** "2026/08/02/0952" → "2026-08-02" (the YYYY-MM-DD frontmatter form). */
function slicePathToDate(path: string): string {
  return path.slice(0, "YYYY/MM/DD".length).replace(/\//g, "-");
}

export interface StrandDescriptionGateInput {
  /** The existing entity file, or null when the strand has none yet. */
  entity: StrandEntity | null;
  /** All slice paths currently under the strand (from strands.json). */
  paths: string[];
  /** Now in ms — injectable for tests. */
  nowMs?: number;
}

export type StrandDescriptionGate =
  | { ok: true; newSliceIds: string[] }
  | { ok: false; reason: string };

/**
 * Mechanical gate for a strand description refresh.
 *
 * - Evidence volume: at least MIN_NEW_SLICES_FOR_DESCRIPTION slice paths must
 *   be NEWER than the entity's last_active (for a strand without an entity
 *   file, that's simply its total slice count — a strand must be a real
 *   thread before it earns a description).
 * - Cooldown: an existing entity may not be refreshed within
 *   STRAND_DESCRIPTION_COOLDOWN_MS of its last_active date.
 *
 * Pure — no I/O, no LLM. Returns the triggering slice ids (the evidence the
 * refresh must cite) alongside a pass.
 */
export function gateStrandDescriptionRefresh({
  entity,
  paths,
  nowMs = Date.now(),
}: StrandDescriptionGateInput): StrandDescriptionGate {
  // Day-granularity anchor: last_active is a YYYY-MM-DD date, so "new" means
  // a slice from a LATER day — a same-day slice was part of the refresh that
  // stamped that date.
  const lastActiveDay = entity?.last_active ?? "";
  const lastActiveMs = lastActiveDay ? Date.parse(lastActiveDay) : NaN;

  const fresh = paths.filter((p) => {
    if (slicePathToMs(p) === null) return false;
    return slicePathToDate(p) > lastActiveDay;
  });

  if (fresh.length < MIN_NEW_SLICES_FOR_DESCRIPTION) {
    return {
      ok: false,
      reason:
        `only ${fresh.length} new slice(s) since the last refresh ` +
        `(need ${MIN_NEW_SLICES_FOR_DESCRIPTION})`,
    };
  }

  if (entity && Number.isFinite(lastActiveMs) && lastActiveMs > 0) {
    const elapsed = nowMs - lastActiveMs;
    if (elapsed >= 0 && elapsed < STRAND_DESCRIPTION_COOLDOWN_MS) {
      return {
        ok: false,
        reason:
          `cooldown: last refresh ${Math.floor(elapsed / 86_400_000)}d ago ` +
          `(< ${Math.floor(STRAND_DESCRIPTION_COOLDOWN_MS / 86_400_000)}d)`,
      };
    }
  }

  return { ok: true, newSliceIds: fresh.map(slicePathToId) };
}

// ─── Description LLM pass ─────────────────────────────────────────────────

const strandDescriptionSchema = z.object({
  description: z
    .string()
    .describe(
      "1-2 paragraphs of natural language: when the user FIRST raised this thread, " +
      "what it is mainly about, how it developed across the evidence slices. " +
      "No headers, no bullet lists.",
    ),
  aliases: z
    .array(z.string())
    .max(5)
    .catch([])
    .describe(
      "Up to 5 alternate names for the same thread (other languages, typo " +
      "variants). Empty when the canonical name is the only one used.",
    ),
  reasoning: z.string().describe("One short phrase for the developer log."),
});

const STRAND_DESCRIPTION_SYSTEM = buildSubAgentSystem(`You are the strand-descriptions agent for a personal memory system.

A "strand" is a topic thread woven through time slices (slices/YYYY/MM/DD/HHMM) — "the whole history of that thing" across conversations. Each strand has an entity file whose body is a natural-language description of the thread.

## Task

Write (or revise) ONE strand's description. The user message gives you the strand's name, the slice ids that triggered this refresh (the new evidence), and — on a revision — the current description.

## Rules

1. The description MUST be grounded in the triggering slices listed in the user message: what happened in THOSE conversations is the new material. Do not invent content you cannot attribute to the evidence.
2. On a REVISION, keep what is still true of the old description and fold the new evidence in — do not rewrite from scratch if the existing text is accurate.
3. first_seen / last_active dates and the slice list are maintained mechanically by the caller — never put a slice roster or date bookkeeping in the description prose.
4. Answer in the user's language when the strand name is non-English.

## Output

Call \`strandDescriptionOutput\` with the description, any aliases, and a short reasoning note.`);

function buildDescriptionPrompt(
  name: string,
  totalSlices: number,
  newSliceIds: string[],
  existing: StrandEntity | null,
): string {
  const evidence = newSliceIds.map((id) => `- ${id}`).join("\n");
  const revisionBlock = existing
    ? `\n## Current description (revise — keep what is still true)\n\n${existing.description}\n`
    : "";
  return `## Strand: ${name}

Carried by ${totalSlices} slice(s) in total. The following ${newSliceIds.length} slice(s) are the NEW evidence that triggered this refresh — ground the description in them:

${evidence}
${revisionBlock}
Write the strand description per your instructions.`;
}

async function proposeDescription(
  model: ModelConfig,
  input: { name: string; totalSlices: number; newSliceIds: string[]; existing: StrandEntity | null },
): Promise<{ description: string; aliases: string[] } | null> {
  const result = await runSubAgent({
    model,
    system: STRAND_DESCRIPTION_SYSTEM,
    prompt: buildDescriptionPrompt(input.name, input.totalSlices, input.newSliceIds, input.existing),
    temperature: 0,
    maxSteps: 50,
    timeoutMs: 30_000,
    tools: {
      strandDescriptionOutput: tool({
        description: "Report the strand description.",
        inputSchema: strandDescriptionSchema,
      }),
    },
    toolChoice: "required",
    reportToolName: "strandDescriptionOutput",
    reportSchema: strandDescriptionSchema,
    progress: { toolName: "strand-consolidator" },
  });

  // Same degradation contract as proposeMerges: no report → no write.
  if (!result.ok || !result.report) return null;
  const description = result.report.description?.trim();
  if (!description) return null;
  return { description, aliases: result.report.aliases ?? [] };
}

// ─── Public entry: gated description refresh ──────────────────────────────

export interface RefreshStrandDescriptionInput {
  /** The strand key (as in strands.json — the entity file name). */
  name: string;
  /**
   * The slice ids that triggered this refresh — REQUIRED evidence. An empty
   * list is refused: a description update may never happen without naming
   * the new slices it is based on.
   */
  sliceIds: string[];
  /** All slice paths currently under the strand (mechanical date source). */
  paths: string[];
  model: ModelConfig;
  batch?: WriteBatch;
  /** Now in ms — injectable for tests. */
  nowMs?: number;
}

export interface RefreshStrandDescriptionResult {
  ok: boolean;
  reason?: string;
}


/**
 * Create or refresh ONE strand's entity description — the only write path
 * into strands/<name>.md. Enforces, in order:
 * 1. Evidence parameter: sliceIds must name the triggering slices (non-empty).
 * 2. The mechanical gate (gateStrandDescriptionRefresh): ≥5 new slices AND
 *    outside the 7-day cooldown. The gate's slice set must match sliceIds —
 *    a caller cannot smuggle in a stale refresh by passing old evidence.
 * 3. The LLM description must come back non-empty (else no write).
 *
 * first_seen / last_active are derived mechanically from the slice paths,
 * never from the model. Never throws — a refusal/failure comes back as
 * { ok: false, reason }.
 */
export async function refreshStrandDescription({
  name,
  sliceIds,
  paths,
  model,
  batch,
  nowMs,
}: RefreshStrandDescriptionInput): Promise<RefreshStrandDescriptionResult> {
  if (sliceIds.length === 0) {
    return {
      ok: false,
      reason: "evidence required: sliceIds must list the slices that triggered this refresh",
    };
  }

  let existing: StrandEntity | null;
  try {
    existing = await readStrandEntity(name, batch);
  } catch {
    existing = null;
  }

  const gate = gateStrandDescriptionRefresh({ entity: existing, paths, nowMs });
  if (!gate.ok) return { ok: false, reason: gate.reason };

  // The evidence the caller supplied must BE the fresh set the gate found —
  // same size and same ids (order-insensitive).
  const supplied = new Set(sliceIds);
  const expected = new Set(gate.newSliceIds);
  const sameEvidence =
    supplied.size === expected.size && [...supplied].every((id) => expected.has(id));
  if (!sameEvidence) {
    return {
      ok: false,
      reason: "sliceIds do not match the slices that actually triggered this refresh",
    };
  }

  const proposed = await proposeDescription(model, {
    name,
    totalSlices: paths.length,
    newSliceIds: gate.newSliceIds,
    existing,
  });
  if (!proposed) {
    return { ok: false, reason: "description pass produced no output" };
  }

  // Mechanical dates from the slice paths: first_seen = earliest, last_active
  // = newest (== the refresh instant's knowledge boundary).
  const dated = paths
    .map((p) => ({ path: p, ms: slicePathToMs(p) }))
    .filter((e): e is { path: string; ms: number } => e.ms !== null)
    .sort((a, b) => a.ms - b.ms);
  if (dated.length === 0) {
    return { ok: false, reason: "strand has no parseable slice paths" };
  }

  try {
    await writeStrandEntity(
      {
        name,
        first_seen: slicePathToDate(dated[0].path),
        last_active: slicePathToDate(dated[dated.length - 1].path),
        aliases: proposed.aliases,
        description: proposed.description,
      },
      batch,
    );
  } catch (e) {
    return { ok: false, reason: `write failed: ${e instanceof Error ? e.message : e}` };
  }

  return { ok: true };
}

export interface RefreshStrandDescriptionsResult {
  refreshed: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Sweep the whole index: refresh every strand whose description is due
 * (gate passes), capped at MAX_DESCRIPTION_REFRESHES_PER_PASS LLM calls per
 * pass so consolidation stays cheap. Per-strand failures are collected, never
 * thrown — the pass degrades like the rest of this module.
 */
export async function refreshStrandDescriptions(
  strands: StrandIndex,
  model: ModelConfig,
  batch?: WriteBatch,
): Promise<RefreshStrandDescriptionsResult> {
  const refreshed: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const [name, paths] of Object.entries(strands)) {
    if (refreshed.length >= MAX_DESCRIPTION_REFRESHES_PER_PASS) {
      skipped.push({ name, reason: "per-pass refresh cap reached" });
      continue;
    }
    try {
      const existing = await readStrandEntity(name, batch);
      const gate = gateStrandDescriptionRefresh({ entity: existing, paths });
      if (!gate.ok) {
        skipped.push({ name, reason: gate.reason });
        continue;
      }
      const result = await refreshStrandDescription({
        name,
        sliceIds: gate.newSliceIds,
        paths,
        model,
        batch,
      });
      if (result.ok) {
        refreshed.push(name);
      } else {
        skipped.push({ name, reason: result.reason ?? "refresh failed" });
      }
    } catch (e) {
      skipped.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { refreshed, skipped };
}
