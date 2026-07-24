/**
 * Flash Metadata Maintenance — focused Flash call for slice metadata updates.
 *
 * A single DeepSeek Flash call that reviews the current slice state against
 * recent conversation and updates focus/summary/decisions/open_loops/tags/tone.
 * Runs as a pre-turn step — no recall, no beliefs, no intent classification.
 */

import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type { SliceMetadata } from "@/lib/episodic/maintenance";

// ─── Types ──────────────────────────────────────────────────────────────

export interface MetadataUpdateInput {
  slice: SliceMetadata;
  recentTurns: Array<{ role: string; content: string }>;
  newMessage: string;
}

export interface MetadataUpdateOutput {
  needs_metadata_update: boolean;
  metadata_updates: Partial<SliceMetadata> | null;
  reasoning: string;
}

type NullableUpdates = {
  focus?: string | null;
  summary?: string | null;
  open_loops?: string[] | null;
  decisions?: string[] | null;
  tags?: string[] | null;
  emotional_tone?: string | null;
};

// ─── Structured output schema ──────────────────────────────────────────

const metadataSchema = tool({
  description: "Report metadata updates for the current time slice.",
  inputSchema: z.object({
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

// ─── Prompt builder ────────────────────────────────────────────────────

function buildMetadataPrompt(input: MetadataUpdateInput): string {
  const { slice, recentTurns, newMessage } = input;

  let prompt = `You are the metadata maintenance layer for a personal AI platform.
Your job: review the current time slice's metadata and update fields that have changed.

## Current Time Slice
- ID: ${slice.slice_id}
- Focus: ${slice.focus || "not yet set"}
- Summary: ${slice.summary || "not yet set"}
- Open loops: ${slice.open_loops.length > 0 ? slice.open_loops.map((l) => `"${l}"`).join(", ") : "none"}
- Decisions: ${slice.decisions.length > 0 ? slice.decisions.map((d) => `"${d}"`).join(", ") : "none"}
- Tags: ${slice.tags.length > 0 ? slice.tags.join(", ") : "none"}
- Emotional tone: ${slice.emotional_tone || "neutral"}

## Recent Conversation (last ${recentTurns.length} turns)
`;

  for (const t of recentTurns.slice(-8)) {
    prompt += `${t.role}: ${t.content.slice(0, 500)}\n\n`;
  }

  prompt += `## New User Message
"${newMessage}"

## Your Task

Review the current slice metadata. Is anything stale or missing?
- Summary: update if the conversation has advanced beyond the current summary
- Focus: change ONLY if the topic has fundamentally shifted (rare — leave alone if unsure)
- Decisions: add new concrete decisions or conclusions reached in recent turns
- Open loops: add new unresolved issues; you may remove ones that were clearly resolved
- Tags: add any new topic domains that emerged
- Emotional tone: update if the mood has clearly shifted

CONSTRAINT: Only update fields that have actually changed.
Set needs_metadata_update: false if nothing needs changing.
Omit unchanged fields from metadata_updates — null means "clear this field", omission means "no change".

Call the flashOutput tool with your analysis.`;

  return prompt;
}

// ─── Flash call ────────────────────────────────────────────────────────

const FLASH_RETRY_DELAY_MS = 300;

async function attemptMetadataUpdate(
  prompt: string,
): Promise<MetadataUpdateOutput> {
  const result = await generateText({
    model: deepseek("deepseek-v4-flash"),
    prompt,
    temperature: 0.1,
    tools: { flashOutput: metadataSchema },
    toolChoice: "required",
    providerOptions: {
      deepseek: { thinking: { type: "disabled" as const } },
    },
  });

  const toolCall = result.toolCalls?.[0];
  if (
    toolCall?.toolName === "flashOutput" &&
    (toolCall as Record<string, unknown>).input
  ) {
    const input = (toolCall as Record<string, unknown>).input as {
      needs_metadata_update: boolean;
      metadata_updates: Partial<SliceMetadata> | null;
      reasoning: string;
    };

    const updates: Partial<SliceMetadata> = {};
    if (input.metadata_updates) {
      const mu = input.metadata_updates as Record<string, unknown>;
      if (mu.focus !== undefined) updates.focus = (mu.focus as string) ?? "";
      if (mu.summary !== undefined) updates.summary = (mu.summary as string) ?? "";
      if (mu.decisions !== undefined) updates.decisions = (mu.decisions as string[]) ?? [];
      if (mu.open_loops !== undefined) updates.open_loops = (mu.open_loops as string[]) ?? [];
      if (mu.tags !== undefined) updates.tags = (mu.tags as string[]) ?? [];
      if (mu.emotional_tone !== undefined) updates.emotional_tone = (mu.emotional_tone as string) ?? "";
    }

    return {
      needs_metadata_update: input.needs_metadata_update,
      metadata_updates: input.needs_metadata_update ? updates : null,
      reasoning: input.reasoning ?? "",
    };
  }

  throw new Error("Flash did not call the expected tool");
}

/**
 * Run the metadata update Flash call.
 * Never throws — falls back to no-update on failure.
 */
export async function runMetadataUpdate(
  input: MetadataUpdateInput,
): Promise<MetadataUpdateOutput> {
  const prompt = buildMetadataPrompt(input);

  try {
    return await attemptMetadataUpdate(prompt);
  } catch (firstError) {
    console.warn(
      "[Metadata] First attempt failed, retrying:",
      firstError instanceof Error ? firstError.message : firstError,
    );
    await new Promise((resolve) => setTimeout(resolve, FLASH_RETRY_DELAY_MS));
    try {
      return await attemptMetadataUpdate(prompt);
    } catch {
      return {
        needs_metadata_update: false,
        metadata_updates: null,
        reasoning: "Metadata Flash unavailable, no updates applied",
      };
    }
  }
}
