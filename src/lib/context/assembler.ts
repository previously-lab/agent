import type { MemoryNode, NodeMeta } from "@/lib/memory/types";

export interface AssembledContext {
  prompt: string;
  tokenEstimate: number;
  layers: {
    system: number;
    core: number;
    session: number;
    extended: number;
    reference: number;
  };
}

export interface AssemblyInput {
  systemPrompt: string;
  coreNodes: MemoryNode[];
  extendedNodes: MemoryNode[];
  referenceNodes: NodeMeta[];
  sessionSummary: string;
  recentTurns: Array<{ role: string; content: string }>;
  tokenBudget?: number;
}

const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * Estimate tokens from character count (rough heuristic: 4 chars ≈ 1 token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Assemble the final prompt from the system prompt, scored memory layers, and
 * session state, under a token budget.
 *
 * The caller (chat route) owns the identity/directives/episodic-recall grounding
 * and passes it in as `systemPrompt` — so the assembly order is:
 *   Layer 0: System prompt (identity + directives + episodic recall grounding)
 *   Layer 1: Core nodes (full content)
 *   Layer 2: Session context
 *   Layer 3: Extended nodes (summary only)
 *   Layer 4: Reference nodes (titles only)
 *
 * The user's turn is NOT included here — it is passed to the model as the last
 * chat message, not duplicated into the system prompt.
 */
export function assembleContext(input: AssemblyInput): AssembledContext {
  const budget = input.tokenBudget && input.tokenBudget > 0
    ? input.tokenBudget
    : DEFAULT_TOKEN_BUDGET;

  // ---- Layer 0: System prompt ----
  const system = input.systemPrompt;
  let used = estimateTokens(system);

  // ---- Layer 1: Core nodes (full content) ----
  let coreText = "";
  for (const node of input.coreNodes) {
    const block = formatNodeFull(node);
    const tokens = estimateTokens(block);
    if (used + tokens > budget * 0.7) break; // reserve 30% for later layers
    coreText += block + "\n\n";
    used += tokens;
  }

  // ---- Layer 2: Session context ----
  const sessionText = formatSession(input.sessionSummary, input.recentTurns);
  const sessionTokens = estimateTokens(sessionText);
  used += sessionTokens;

  // ---- Layer 3: Extended nodes (summary only) ----
  let extendedText = "";
  for (const node of input.extendedNodes) {
    const block = formatNodeSummary(node);
    const tokens = estimateTokens(block);
    if (used + tokens > budget - 500) break;
    extendedText += block + "\n\n";
    used += tokens;
  }

  // ---- Layer 4: Reference nodes (titles only) ----
  let referenceText = "";
  if (input.referenceNodes.length > 0) {
    referenceText = "## Related Topics\n";
    for (const node of input.referenceNodes) {
      const nodeId = node.path?.split("/").pop()?.replace(".md", "") ?? "";
      referenceText += `- [[${nodeId}]]\n`;
    }
    used += estimateTokens(referenceText);
  }

  const prompt = [system, coreText, sessionText, extendedText, referenceText]
    .filter(Boolean)
    .join("\n\n---\n\n");

  return {
    prompt,
    tokenEstimate: used,
    layers: {
      system: estimateTokens(system),
      core: estimateTokens(coreText),
      session: sessionTokens,
      extended: estimateTokens(extendedText),
      reference: estimateTokens(referenceText),
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
          .map((t) => `**${t.role}**: ${t.content}`)
          .join("\n\n")
    );
  }
  return parts.join("\n\n");
}
