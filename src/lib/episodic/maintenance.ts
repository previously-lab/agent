/**
 * Flash Metadata Maintenance — unified Flash call for episodic memory.
 *
 * Replaces the scattered Flash calls (classifyWithFlash intent, checkContinuity,
 * per-6-turns summary) with ONE call per request that handles:
 *   1. Intent classification + suggested topics
 *   2. Recall scan (recent slice summaries → relevance judgment)
 *   3. Metadata maintenance (focus/summary/decisions/open_loops/tags/tone)
 *
 * Flash acts as a "conditioned reflex" layer — fast, shallow, possibly
 * inaccurate. Pro handles deep recall (readMemory, listMemory) when Flash
 * finds nothing or when deeper context is needed.
 */

import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";

// ─── Types ──────────────────────────────────────────────────────────────

export interface SliceMetadata {
  slice_id: string;
  focus: string;
  summary: string;
  open_loops: string[];
  decisions: string[];
  tags: string[];
  emotional_tone: string;
}

export interface RecentSummary {
  slice_id: string;
  focus: string;
  summary: string;
  start: string;
  tags: string[];
}

export interface MaintenanceInput {
  slice: SliceMetadata;
  recentTurns: Array<{ role: string; content: string }>;
  newMessage: string;
  recentSummaries: RecentSummary[];
}

export interface MaintenanceOutput {
  intent: string;
  confidence: number;
  suggested_topics: string[];
  recall_hits: Array<{
    slice_id: string;
    relevance: number;
    reason: string;
  }>;
  needs_metadata_update: boolean;
  metadata_updates: Partial<SliceMetadata> | null;
  reasoning: string;
}

// ─── Structured output schema ──────────────────────────────────────────

const unifiedFlashSchema = tool({
  description:
    "Report intent classification, recall hits, and metadata updates in one pass.",
  inputSchema: z.object({
    intent: z.enum([
      "code_debug",
      "code_write",
      "explain",
      "chat",
      "review",
      "clarify",
    ]),
    confidence: z.number().min(0).max(1).describe("Confidence in the intent classification, 0-1"),
    suggested_topics: z
      .array(z.string())
      .describe("Topic names for deeper recall search. Lowercase, dash-separated."),

    recall_hits: z
      .array(
        z.object({
          slice_id: z.string().describe("Slice ID in YYYY-MM-DD-HHMM format"),
          relevance: z.number().min(0).max(1).describe("How relevant this slice is, 0-1"),
          reason: z.string().describe("One-line explanation of why relevant"),
        })
      )
      .describe("Past slices relevant to the current message. Empty array if none found."),

    needs_metadata_update: z
      .boolean()
      .describe("Whether any metadata field needs updating based on new conversation content"),

    metadata_updates: z
      .object({
        focus: z
          .string()
          .nullable()
          .optional()
          .describe("Updated focus line, or null to clear. Omit if no change."),
        summary: z
          .string()
          .nullable()
          .optional()
          .describe("Updated summary, or null to clear. Omit if no change."),
        decisions: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("Updated decisions list, or null to clear. Omit if no change."),
        open_loops: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("Updated open loops list, or null to clear. Omit if no change."),
        tags: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("Updated tags, or null to clear. Omit if no change."),
        emotional_tone: z
          .enum(["positive", "neutral", "negative", "mixed"])
          .nullable()
          .optional()
          .describe("Updated emotional tone, or null to clear. Omit if no change."),
      })
      .nullable()
      .optional()
      .describe("Metadata fields to update. null means no changes. Omitted fields mean no change."),

    reasoning: z
      .string()
      .describe("Brief reasoning about what you decided and why (1-2 sentences)"),
  }),
});

// ─── Flash call ────────────────────────────────────────────────────────
// No timeout — Flash is reliability-critical. Model slowness is tolerated.

const FLASH_RETRY_DELAY_MS = 300;

async function attemptUnifiedFlash(
  prompt: string
): Promise<MaintenanceOutput> {
  const result = await generateText({
    model: deepseek("deepseek-v4-flash"),
    prompt,
    temperature: 0.1,
    tools: { flashOutput: unifiedFlashSchema },
    toolChoice: "required",
    // V4 models default to thinking ENABLED — Flash is a conditioned
    // reflex, so force it off for latency and clean tool output.
    providerOptions: {
      deepseek: { thinking: { type: "disabled" as const } },
    },
  });

  const toolCall = result.toolCalls?.[0];
  if (toolCall?.toolName === "flashOutput" && (toolCall as Record<string, unknown>).input) {
    const input = (toolCall as Record<string, unknown>).input as {
      intent: string;
      confidence: number;
      suggested_topics: string[];
      recall_hits: Array<{ slice_id: string; relevance: number; reason: string }>;
      needs_metadata_update: boolean;
      metadata_updates: Partial<SliceMetadata> | null;
      reasoning: string;
    };

    // Build output, merging nullable fields from metadata_updates
    const updates: Partial<SliceMetadata> = {};
    if (input.metadata_updates) {
      const mu = input.metadata_updates;
      if (mu.focus !== undefined) updates.focus = mu.focus ?? "";
      if (mu.summary !== undefined) updates.summary = mu.summary ?? "";
      if (mu.decisions !== undefined) updates.decisions = mu.decisions ?? [];
      if (mu.open_loops !== undefined) updates.open_loops = mu.open_loops ?? [];
      if (mu.tags !== undefined) updates.tags = mu.tags ?? [];
      if (mu.emotional_tone !== undefined) updates.emotional_tone = mu.emotional_tone ?? "";
    }

    return {
      intent: input.intent,
      confidence: input.confidence,
      suggested_topics: input.suggested_topics ?? [],
      recall_hits: input.recall_hits ?? [],
      needs_metadata_update: input.needs_metadata_update,
      metadata_updates: input.needs_metadata_update ? updates : null,
      reasoning: input.reasoning ?? "",
    };
  }

  throw new Error("Flash did not call the expected tool");
}

// ─── Prompt builder ────────────────────────────────────────────────────

function buildUnifiedPrompt(input: MaintenanceInput): string {
  const { slice, recentTurns, newMessage, recentSummaries } = input;

  // Current slice context
  let prompt = `You are the Flash memory layer for Previously, a personal AI platform.
You have three jobs. Do them all in one pass.

## Current Time Slice
- ID: ${slice.slice_id}
- Focus: ${slice.focus || "not yet set"}
- Summary: ${slice.summary || "not yet set"}
- Open loops: ${slice.open_loops.length > 0 ? slice.open_loops.map(l => `"${l}"`).join(", ") : "none"}
- Decisions: ${slice.decisions.length > 0 ? slice.decisions.map(d => `"${d}"`).join(", ") : "none"}
- Tags: ${slice.tags.length > 0 ? slice.tags.join(", ") : "none"}
- Emotional tone: ${slice.emotional_tone || "neutral"}

## Recent Conversation (last ${recentTurns.length} turns)
`;

  for (const t of recentTurns.slice(-8)) {
    prompt += `${t.role}: ${t.content.slice(0, 500)}\n\n`;
  }

  prompt += `## New User Message
"${newMessage}"

`;

  // Recent past conversations (summaries only, for recall scan)
  if (recentSummaries.length > 0) {
    prompt += `## Recent Past Conversations (summaries only — scan for relevance)
`;
    for (const s of recentSummaries) {
      const tags = s.tags?.length ? s.tags.join(", ") : "untagged";
      prompt += `[${s.slice_id}] ${s.focus || s.summary || "untitled"} | Tags: ${tags}\n`;
    }
    prompt += "\n";
  } else {
    prompt += `## Recent Past Conversations
No past conversations available yet.
\n`;
  }

  prompt += `## Your Three Jobs

### 1. INTENT
Classify the user's intent based on the new message and recent conversation context.
Available intents: code_debug | code_write | explain | chat | review | clarify
Also suggest topics for deeper recall search.

### 2. RECALL
Scan the past conversation summaries above. Which ones are genuinely relevant to
what the user is asking NOW? You are the "conditioned reflex" layer — fast and
shallow. If you miss something, Pro will do deeper search.
- Return up to 5 relevant slices with relevance scores (0-1) and a one-line reason.
- If nothing seems relevant, return an empty array. That is fine.
- Only flag slices where there is a clear connection to the current message.

### 3. MAINTENANCE
Review the current time slice's metadata. Is anything stale or missing?
- Summary: update if the conversation has advanced beyond the current summary
- Focus: change ONLY if the topic has fundamentally shifted (rare — leave alone if unsure)
- Decisions: add new concrete decisions or conclusions reached in recent turns
- Open loops: add new unresolved issues; you may remove ones that were clearly resolved
- Tags: add any new topic domains that emerged
- Emotional tone: update if the mood has clearly shifted

CONSTRAINT: Only update fields that have actually changed.
Set needs_metadata_update: false if nothing needs changing.
Omit unchanged fields from metadata_updates — null means "clear this field", omission means "no change".

Call the flashOutput tool with your complete analysis.`;

  return prompt;
}

// ─── Read recent summaries ─────────────────────────────────────────────

import { readSliceIndex } from "./manager";

export async function readRecentSummaries(
  limit: number = 20
): Promise<RecentSummary[]> {
  const now = new Date();
  const summaries: RecentSummary[] = [];
  const maxMonths = 24; // scan up to 2 years back

  for (let i = 0; i < maxMonths && summaries.length < limit; i++) {
    let m = now.getUTCMonth() + 1 - i;
    let y = now.getUTCFullYear();
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    try {
      const index = await readSliceIndex(y, m);
      // Monthly index is stored ascending (oldest → newest); iterate
      // newest-first so we collect the genuinely recent slices, not the
      // oldest `limit` of the month.
      for (const entry of [...index].reverse()) {
        if (entry.status !== "closed") continue;
        // Construct full slice_id from the index entry
        const sliceId = entry.id?.includes("-")
          ? entry.id // already YYYY-MM-DD
          : `${entry.start.slice(0, 7)}/${entry.id}`; // legacy DD format
        summaries.push({
          slice_id: sliceId,
          focus: entry.focus,
          summary: entry.summary,
          start: entry.start,
          tags: entry.tags ?? [],
        });
        if (summaries.length >= limit) break;
      }
    } catch {
      // month index may not exist
    }
    if (summaries.length >= limit) break;
  }

  return summaries;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Run the unified Flash call: intent + recall + maintenance in one pass.
 * No timeout — Flash reliability is more important than latency.
 */
export async function runUnifiedFlash(
  input: MaintenanceInput
): Promise<MaintenanceOutput> {
  const prompt = buildUnifiedPrompt(input);

  try {
    return await attemptUnifiedFlash(prompt);
  } catch (firstError) {
    console.warn(
      "[Flash] First attempt failed, retrying after delay:",
      firstError instanceof Error ? firstError.message : firstError
    );
    // Retry once
    await new Promise((resolve) => setTimeout(resolve, FLASH_RETRY_DELAY_MS));
    try {
      return await attemptUnifiedFlash(prompt);
    } catch {
      // Both attempts failed — return safe defaults
      return {
        intent: "chat",
        confidence: 0.3,
        suggested_topics: [],
        recall_hits: [],
        needs_metadata_update: false,
        metadata_updates: null,
        reasoning: "Flash unavailable, fell back to defaults",
      };
    }
  }
}

/**
 * Apply metadata updates from Flash to the slice object.
 * undefined = no change (omit the field).
 * null = clear the field (set to empty string/array).
 * Any other value = update.
 */
type NullableUpdates = {
  focus?: string | null;
  summary?: string | null;
  open_loops?: string[] | null;
  decisions?: string[] | null;
  tags?: string[] | null;
  emotional_tone?: string | null;
};

export function applyMetadataUpdates(
  slice: SliceMetadata,
  updates: NullableUpdates | null
): void {
  if (!updates) return;

  // String fields: null clears, undefined skips
  if (updates.focus !== undefined) slice.focus = updates.focus ?? "";
  if (updates.summary !== undefined) slice.summary = updates.summary ?? "";
  if (updates.emotional_tone !== undefined) slice.emotional_tone = updates.emotional_tone ?? "";

  // Array fields: null clears, undefined skips
  if (updates.decisions !== undefined) slice.decisions = updates.decisions ?? [];
  if (updates.open_loops !== undefined) slice.open_loops = updates.open_loops ?? [];
  if (updates.tags !== undefined) slice.tags = updates.tags ?? [];
}
