import type { MemoryNode, NodeMeta } from "@/lib/memory/types";

export interface AssembledContext {
  prompt: string;
  tokenEstimate: number;
  layers: {
    sliceState: number;
    system: number;
    core: number;
    session: number;
    extended: number;
    reference: number;
    input: number;
  };
}

export interface AssemblyInput {
  systemPrompt: string;
  coreNodes: MemoryNode[];
  extendedNodes: MemoryNode[];
  referenceNodes: NodeMeta[];
  sessionSummary: string;
  recentTurns: Array<{ role: string; content: string }>;
  userInput: string;
  tokenBudget?: number;
  /** Active (currently open) time slice — goes into Layer 0 */
  activeSlice?: {
    focus: string;
    summary: string;
    open_loops: string[];
    decisions: string[];
    recentTurns?: string;
  };
  /** Recently closed time slices (3-5, frontmatter only) — goes into Layer 1 */
  recentSlices?: Array<{
    slice_id: string;
    focus: string;
    summary: string;
    open_loops: string[];
  }>;
}

const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * Estimate tokens from character count (rough heuristic: 4 chars ≈ 1 token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format the active time slice as a Layer 0 context block.
 */
function formatSliceState(active: NonNullable<AssemblyInput["activeSlice"]>): string {
  const parts: string[] = [];

  parts.push("## Active Time Slice");
  parts.push(`**Focus**: ${active.focus}`);
  parts.push(`**Summary**: ${active.summary}`);

  if (active.open_loops.length > 0) {
    parts.push("\nOpen Loops:");
    for (const loop of active.open_loops) {
      parts.push(`- ${loop}`);
    }
  }

  if (active.decisions.length > 0) {
    parts.push("\nDecisions Made:");
    for (const decision of active.decisions) {
      parts.push(`- ${decision}`);
    }
  }

  if (active.recentTurns) {
    parts.push(`\nRecent Turns:\n${active.recentTurns}`);
  }

  return parts.join("\n");
}

/**
 * Format recently closed time slices as a Layer 1 context block.
 * Only includes focus + summary, a few lines each.
 */
function formatRecentSlices(
  slices: NonNullable<AssemblyInput["recentSlices"]>
): string {
  const parts: string[] = ["## Recent Closed Slices"];

  for (const slice of slices) {
    parts.push(
      `- **${slice.slice_id}** (${slice.focus}): ${slice.summary}`
    );
  }

  return parts.join("\n");
}

/**
 * Assemble the final prompt from scored memory layers, session state,
 * and time-slice state. Strict 8-layer assembly order.
 * Handles token budget enforcement.
 *
 * Assembly order:
 *   Layer 0: Active slice state (focus + summary + open_loops + decisions + recent turns)
 *   Layer 1: Recent closed slice summaries (3-5, focus + summary only)
 *   Layer 2: System prompt
 *   Layer 3: Core nodes (full content)
 *   Layer 4: Session context
 *   Layer 5: Extended nodes (summary only)
 *   Layer 6: Reference nodes (titles only)
 *   Layer 7: User input
 */
export function assembleContext(input: AssemblyInput): AssembledContext {
  const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxSliceBudget = Math.floor(budget * 0.15);
  let sliceBudgetUsed = 0;

  // ---- Layer 0: Active slice state ----
  let sliceStateText = "";
  if (input.activeSlice) {
    const fullText = formatSliceState(input.activeSlice);
    const fullTokens = estimateTokens(fullText);
    if (fullTokens <= maxSliceBudget) {
      sliceStateText = fullText;
      sliceBudgetUsed = fullTokens;
    } else {
      // Trim to fit within 15% budget: keep focus + summary, drop optional fields
      const minimalText = [
        "## Active Time Slice",
        `**Focus**: ${input.activeSlice.focus}`,
        `**Summary**: ${input.activeSlice.summary}`,
        input.activeSlice.open_loops.length > 0
          ? "\nOpen Loops:\n" +
            input.activeSlice.open_loops.map((l) => `- ${l}`).join("\n")
          : "",
        input.activeSlice.decisions.length > 0
          ? "\nDecisions Made:\n" +
            input.activeSlice.decisions.map((d) => `- ${d}`).join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const minimalTokens = estimateTokens(minimalText);
      if (minimalTokens <= maxSliceBudget) {
        sliceStateText = minimalText;
        sliceBudgetUsed = minimalTokens;
      } else {
        // Even more aggressive: only focus + summary
        const bareText = [
          "## Active Time Slice",
          `**Focus**: ${input.activeSlice.focus}`,
          `**Summary**: ${input.activeSlice.summary}`,
        ].join("\n");
        sliceStateText = bareText;
        sliceBudgetUsed = estimateTokens(bareText);
      }
    }
  }

  const sliceStateTokens = sliceBudgetUsed;

  // ---- Layer 1: Recent closed slices ----
  let recentSlicesText = "";
  if (input.recentSlices && input.recentSlices.length > 0) {
    const fullText = formatRecentSlices(input.recentSlices);
    const fullTokens = estimateTokens(fullText);
    const remainingSliceBudget = maxSliceBudget - sliceBudgetUsed;
    if (fullTokens <= remainingSliceBudget) {
      recentSlicesText = fullText;
      sliceBudgetUsed += fullTokens;
    } else {
      // Trim: show fewer slices
      for (let i = input.recentSlices.length; i > 0; i--) {
        const subset = input.recentSlices.slice(0, i);
        const subsetText = formatRecentSlices(subset);
        const subsetTokens = estimateTokens(subsetText);
        if (subsetTokens <= remainingSliceBudget) {
          recentSlicesText = subsetText;
          sliceBudgetUsed += subsetTokens;
          break;
        }
        if (i === 1) {
          // Show just one slice
          recentSlicesText = subsetText;
          sliceBudgetUsed += subsetTokens;
        }
      }
    }
  }

  const recentSlicesTokens = sliceBudgetUsed - sliceStateTokens;

  // ---- Layer 2 (was 1): System prompt ----
  const system = input.systemPrompt;
  let used = estimateTokens(system);

  // ---- Layer 3 (was 2): Core nodes (full content) ----
  let coreText = "";
  for (const node of input.coreNodes) {
    const block = formatNodeFull(node);
    const tokens = estimateTokens(block);
    if (used + tokens > budget * 0.7) break; // reserve 30% for later layers
    coreText += block + "\n\n";
    used += tokens;
  }

  // ---- Layer 4 (was 3): Session context ----
  const sessionText = formatSession(input.sessionSummary, input.recentTurns);
  const sessionTokens = estimateTokens(sessionText);
  used += sessionTokens;

  // ---- Layer 5 (was 4): Extended nodes (summary only) ----
  let extendedText = "";
  for (const node of input.extendedNodes) {
    const block = formatNodeSummary(node);
    const tokens = estimateTokens(block);
    if (used + tokens > budget - 500) break; // leave room for user input
    extendedText += block + "\n\n";
    used += tokens;
  }

  // ---- Layer 6 (was 5): Reference nodes (titles only) ----
  let referenceText = "";
  if (input.referenceNodes.length > 0) {
    referenceText = "## Related Topics\n";
    for (const node of input.referenceNodes) {
      const nodeId = node.path?.split("/").pop()?.replace(".md", "") ?? "";
      referenceText += `- [[${nodeId}]]\n`;
    }
    used += estimateTokens(referenceText);
  }

  // ---- Layer 7 (was 6): User input ----
  const inputText = `## Current Request\n${input.userInput}`;
  const inputTokens = estimateTokens(inputText);
  used += inputTokens;

  // Assemble final prompt (Layer 0 + Layer 1 prepended)
  const prompt = [
    sliceStateText,
    recentSlicesText,
    system,
    coreText,
    sessionText,
    extendedText,
    referenceText,
    inputText,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  return {
    prompt,
    tokenEstimate: used,
    layers: {
      sliceState: sliceStateTokens,
      system: estimateTokens(system),
      core: estimateTokens(coreText),
      session: sessionTokens,
      extended: estimateTokens(extendedText),
      reference: estimateTokens(referenceText),
      input: inputTokens,
    },
  };
}

function formatNodeFull(node: MemoryNode): string {
  return `## ${node.title || node.id}\n${node.content}`;
}

function formatNodeSummary(node: MemoryNode): string {
  const firstPara = node.content.split("\n\n")[0]?.slice(0, 200) ?? "";
  return `## ${node.title || node.id}\n*Tags: ${node.tags.join(", ")} | Priority: ${node.priority}*\n\n${firstPara}...`;
}

function formatSession(
  summary: string,
  turns: Array<{ role: string; content: string }>
): string {
  const parts: string[] = [];
  if (summary) {
    parts.push(`## Session Summary\n${summary}`);
  }
  if (turns.length > 0) {
    parts.push(
      "## Recent Conversation\n" +
        turns
          .map((t) => `**${t.role}**: ${t.content.slice(0, 300)}`)
          .join("\n\n")
    );
  }
  return parts.join("\n\n");
}
