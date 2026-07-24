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
 * inaccurate. Pro handles deep recall (readSlice) when Flash finds nothing
 * or when deeper context is needed.
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

export interface BeliefUpdate {
  action: "observe" | "reinforce" | "contradict" | "discard";
  section: "User identity" | "User patterns" | "Agent strategies";
  /** Full belief text (required for "observe"). */
  belief?: string;
  /**
   * Unique substring to match an existing belief (required for
   * "reinforce" / "contradict" / "discard"). Must appear in the
   * belief bullet line, not the annotation.
   */
  belief_key?: string;
  /** Slice path in YYYY/MM/DD/HHMM format. */
  evidence_slice: string;
  /** Turn ID within the evidence slice. */
  evidence_turn: string;
  /** Explanation of the contradiction (for "contradict"). */
  note?: string;
  /** Why the belief is being removed (for "discard"). */
  reason?: string;
}

export interface MaintenanceInput {
  slice: SliceMetadata;
  recentTurns: Array<{ role: string; content: string }>;
  newMessage: string;
  recentSummaries: RecentSummary[];
  /** Current previously.md content, so Flash can see existing beliefs. */
  previouslyContent: string;
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
  /** Belief mutations Flash observed this turn. Empty array if none. */
  belief_updates: BeliefUpdate[];
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

    belief_updates: z
      .array(
        z.object({
          action: z
            .enum(["observe", "reinforce", "contradict", "discard"])
            .describe("What to do with this belief"),
          section: z
            .enum(["User identity", "User patterns", "Agent strategies"])
            .describe("Which section the belief belongs to"),
          belief: z
            .string()
            .optional()
            .describe("Full belief text. Required for 'observe'."),
          belief_key: z
            .string()
            .optional()
            .describe(
              "Unique substring to match an existing belief. Required for " +
              "'reinforce' / 'contradict' / 'discard'. Must appear in the " +
              "belief bullet line, not the annotation.",
            ),
          evidence_slice: z
            .string()
            .describe("Slice path in YYYY/MM/DD/HHMM format for the citing evidence"),
          evidence_turn: z
            .string()
            .describe("Turn ID within the evidence slice"),
          note: z
            .string()
            .optional()
            .describe("Explanation of the tension (for 'contradict')"),
          reason: z
            .string()
            .optional()
            .describe("Why removing (for 'discard')"),
        }),
      )
      .describe(
        "Belief mutations observed this turn. Empty array if no clear evidence.",
      ),
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
      belief_updates: BeliefUpdate[];
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
      belief_updates: input.belief_updates ?? [],
    };
  }

  throw new Error("Flash did not call the expected tool");
}

// ─── Prompt builder ────────────────────────────────────────────────────

function buildUnifiedPrompt(input: MaintenanceInput): string {
  const { slice, recentTurns, newMessage, recentSummaries, previouslyContent } = input;

  // Current slice context
  let prompt = `You are the Flash memory layer for Previously, a personal AI platform.
You have four jobs. Do them all in one pass.

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

  // Inject previously.md so Flash can see existing beliefs
  if (previouslyContent.trim()) {
    prompt += `## User Beliefs (previously.md — the agent's current understanding of the user)

${previouslyContent.slice(0, 3000)}

`;
  } else {
    prompt += `## User Beliefs (previously.md)
No beliefs established yet.
\n`;
  }

  prompt += `## Your Four Jobs

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

### 4. BELIEF UPDATES (NEW)
Examine the user's latest message and the conversation. Look at the existing
beliefs above. Produce belief_updates — mutations to the belief system.

Evidence quality rules:
- User explicitly states a fact about themselves → "observe" in "User identity"
- User behavior confirms an existing pattern belief → "reinforce" (bump count)
- User behavior contradicts an existing belief → "contradict" with a note
- Stale belief not reinforced in many turns + confidence already 低 → "discard"

For "observe":
- User identity: use 来源 format (factual, user-stated)
- User patterns: use 置信度 format, start at 中 confidence, 观察: 1
- Agent strategies: use 来源 format, cite the motivating User pattern

For "reinforce": bump 观察 count. If ≥5 observations and confidence is 中, promote to 高.
For "contradict": drop confidence one level, explain the tension in note.
For "discard": only when confidence is 低 and no recent reinforcement.

Return belief_updates as an array. Return [] if no clear evidence this turn.
Do NOT fabricate observations just to fill the output.

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
        belief_updates: [],
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

// ─── Belief update application ────────────────────────────────────────────

/**
 * Apply a list of Flash-emitted belief mutations to a previously.md body.
 *
 * Pure string-in/string-out — no I/O, deterministic, testable.
 * Only Flash emits mutations; this function just applies them.
 *
 * - `observe`: append a new belief to the target section
 * - `reinforce`: bump observation count, update 最近 date, promote 中→高 at ≥5 obs
 * - `contradict`: drop confidence one level, append note
 * - `discard`: remove the belief (bullet + annotation lines)
 */
export function applyBeliefUpdates(
  content: string,
  updates: BeliefUpdate[],
  currentSliceId: string,
): string {
  if (!updates.length) return content;

  const lines = content.split("\n");
  const result: string[] = [];

  // Track which section we're in and section boundaries
  const sectionHeaders = [
    "## User identity",
    "## User patterns",
    "## Agent strategies",
  ];
  let currentSection: string | null = null;

  // First pass: apply reinforce/contradict/discard (mutations to existing beliefs)
  // We do this inline during the copy pass below.

  // Second pass: collect observe actions to append at section ends
  const observesBySection: Map<string, string[]> = new Map();

  // Pre-process: separate observe from other actions
  for (const u of updates) {
    if (u.action === "observe" && u.belief) {
      const existing = observesBySection.get(u.section) ?? [];
      const annotation =
        u.section === "User identity"
          ? `  (来源: ${u.evidence_slice}-${u.evidence_turn}，用户原话)`
          : u.section === "Agent strategies"
            ? `  (来源: ${u.belief.slice(0, 80)} — ${u.evidence_slice}-${u.evidence_turn})`
            : `  (置信度: 中 | 首次: ${u.evidence_slice}-${u.evidence_turn} | 最近: ${u.evidence_slice}-${u.evidence_turn} | 观察: 1)`;
      existing.push(`- ${u.belief}\n${annotation}`);
      observesBySection.set(u.section, existing);
    }
  }

  // Build a map of (section, belief_key) → action for fast lookup
  const mutationMap = new Map<string, BeliefUpdate>();
  for (const u of updates) {
    if (u.action !== "observe" && u.belief_key && u.section) {
      mutationMap.set(`${u.section}::${u.belief_key}`, u);
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Track section
    for (const h of sectionHeaders) {
      if (line.startsWith(h)) {
        currentSection = h.replace("## ", "");
        // If this section has pending observes, we'll append them before the next section header or at EOF
        break;
      }
    }
    // If we hit a new section header (other than the three known ones),
    // flush pending observes for the PREVIOUS section
    if (line.startsWith("## ") && !sectionHeaders.some((h) => line.startsWith(h))) {
      currentSection = null;
    }

    // Update the active slice header
    if (/^_Active slice:/.test(line)) {
      result.push(`_Active slice: ${currentSliceId} | Last updated: Turn ${updates[0]?.evidence_turn ?? "?"}_`);
      i++;
      continue;
    }

    // Check if this is a belief bullet line that matches a mutation
    if (line.trimStart().startsWith("- ") && currentSection) {
      // Try to match against pending mutations
      let matchedUpdate: BeliefUpdate | null = null;
      for (const [key, u] of mutationMap) {
        const [section, beliefKey] = key.split("::");
        if (section === currentSection && line.includes(beliefKey)) {
          matchedUpdate = u;
          break;
        }
      }

      if (matchedUpdate) {
        const u = matchedUpdate;
        const nextLine = i + 1 < lines.length ? lines[i + 1] : "";

        if (u.action === "discard") {
          // Skip the belief bullet line (we haven't pushed it yet —
          // the match was detected before the push) and its annotation.
          i++; // Skip bullet
          if (i < lines.length && lines[i].trim().startsWith("(")) {
            i++; // Skip annotation
          }
          if (i < lines.length && lines[i].trim() === "") {
            i++; // Skip trailing blank
          }
          continue;
        }

        if (u.action === "reinforce" && nextLine.includes("置信度:")) {
          // Update annotation
          const annotation = nextLine;
          const now = `${u.evidence_slice}-${u.evidence_turn}`;

          // Bump observation count
          let updatedAnnotation = annotation.replace(
            /观察: (\d+)/,
            (_m, n) => `观察: ${parseInt(n, 10) + 1}`,
          );

          // Update 最近 date
          updatedAnnotation = updatedAnnotation.replace(
            /最近: \S+/,
            `最近: ${now}`,
          );

          // Promote 中→高 at ≥5 observations
          const newObs = parseInt(
            (updatedAnnotation.match(/观察: (\d+)/) ?? ["", "0"])[1],
            10,
          );
          if (newObs >= 5 && updatedAnnotation.includes("置信度: 中")) {
            updatedAnnotation = updatedAnnotation.replace(
              "置信度: 中",
              "置信度: 高",
            );
          }

          result.push(line); // bullet
          result.push(updatedAnnotation); // updated annotation
          i += 2;
          // Skip trailing blank if present
          if (i < lines.length && lines[i].trim() === "") {
            result.push(lines[i]);
            i++;
          }
          continue;
        }

        if (u.action === "contradict" && nextLine.includes("置信度:")) {
          const annotation = nextLine;
          // Drop confidence
          let updatedAnnotation = annotation;
          if (updatedAnnotation.includes("置信度: 高")) {
            updatedAnnotation = updatedAnnotation.replace("置信度: 高", "置信度: 中");
          } else if (updatedAnnotation.includes("置信度: 中")) {
            updatedAnnotation = updatedAnnotation.replace("置信度: 中", "置信度: 低");
          }

          result.push(line);
          result.push(updatedAnnotation);
          // Append note as a comment below the annotation
          if (u.note) {
            result.push(`  <!-- 矛盾: ${u.note} (${u.evidence_slice}-${u.evidence_turn}) -->`);
          }
          i += 2;
          if (i < lines.length && lines[i].trim() === "") {
            result.push(lines[i]);
            i++;
          }
          continue;
        }
      }
    }

    result.push(line);
    i++;
  }

  // Append new observations at the end of each section
  // Rebuild by finding section positions and inserting observes
  let finalResult = result.join("\n");

  for (const [section, beliefs] of observesBySection) {
    const sectionHeader = `## ${section}`;
    const sectionIdx = findSectionEnd(result, section);

    if (sectionIdx >= 0 && beliefs.length > 0) {
      // Insert beliefs before the section end (or at the end of the file)
      const insertText = "\n" + beliefs.join("\n\n") + "\n";
      // Rebuild from result array
      const before = result.slice(0, sectionIdx);
      const after = result.slice(sectionIdx);
      // Find the insertion point: right before the next `## ` header or at end
      let insertAt = after.length; // default: end of file
      for (let j = 0; j < after.length; j++) {
        if (after[j].startsWith("## ")) {
          insertAt = j;
          break;
        }
      }
      const newResult = [...before, ...after.slice(0, insertAt)];
      // Add observe beliefs
      for (const b of beliefs) {
        newResult.push(...b.split("\n"));
        newResult.push(""); // blank separator
      }
      newResult.push(...after.slice(insertAt));
      // Re-assign result and lines for next section
      result.length = 0;
      result.push(...newResult);
      finalResult = result.join("\n");
    }
  }

  return finalResult;
}

/** Find the line index right after a section header's content ends. */
function findSectionEnd(lines: string[], sectionName: string): number {
  const header = `## ${sectionName}`;
  let foundHeader = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(header)) {
      foundHeader = true;
      continue;
    }
    if (foundHeader && lines[i].startsWith("## ")) {
      return i; // Next section starts here
    }
  }
  return foundHeader ? lines.length : -1;
}
