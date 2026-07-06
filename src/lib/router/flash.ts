import { generateText, tool } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import { matchKeywords, type IntentStrategy } from "./speed-index";

export interface FlashResult {
  intent: string;
  confidence: number;
  intent_switched: boolean;
  needs_more_turns: boolean;
  reasoning: string;
  /** Topic names for parallel-timeline lookup (e.g. ["rust", "async"]) */
  suggested_topics?: string[];
  recall_hint?: {
    suggested_tags: string[];
    suggested_time_range: string;
    reason: string;
  };
}

export interface FlashInput {
  currentInput: string;
  lastTurnSummary: string;
  sessionIntent: string;
  recentTurns: Array<{ role: string; content: string }>;
}

// ─── Structured output schema ──────────────────────────────────────────

const flashOutputSchema = tool({
  description:
    "Report the intent classification result. Call this tool exactly once with your analysis.",
  inputSchema: z.object({
    intent: z.enum([
      "code_debug",
      "code_write",
      "explain",
      "chat",
      "review",
      "clarify",
    ]),
    confidence: z.number().min(0).max(1),
    intent_switched: z.boolean(),
    needs_more_turns: z.boolean(),
    reasoning: z.string(),
    suggested_topics: z
      .array(z.string())
      .optional()
      .describe("Topic names this conversation relates to. Lowercase, dash-separated. Ex: ['rust', 'borrow-checker']"),
    recall_hint: z
      .object({
        suggested_tags: z.array(z.string()),
        suggested_time_range: z.enum([
          "last_7_days",
          "last_30_days",
          "last_90_days",
          "all_time",
        ]),
        reason: z.string(),
      })
      .optional(),
  }),
});

// ─── Timeout + retry ───────────────────────────────────────────────────

const FLASH_TIMEOUT_MS = 1000;
const FLASH_RETRY_DELAY_MS = 200;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Flash timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Classify user intent using structured tool output.
 * Flash calls a schema-validated tool — no manual JSON.parse, no regex extraction.
 * Includes 1s timeout + 1 retry on failure.
 */
export async function classifyWithFlash(
  input: FlashInput
): Promise<FlashResult> {
  const turnsSummary = input.recentTurns
    .slice(-3)
    .map((t) => `${t.role}: ${t.content.slice(0, 150)}`)
    .join("\n");

  const prompt = `You are an intent classifier for a personal AI agent platform.

Classify the user's current message based on the context below.

Available intents:
- code_debug: user is debugging code, investigating an error
- code_write: user wants to write or generate code
- explain: user wants an explanation of a concept
- chat: casual conversation, greetings, small talk
- review: user wants a code or design review
- clarify: user's intent is unclear, or they're asking the agent to clarify

Context:
- Session intent: ${input.sessionIntent}
- Last turn summary: ${input.lastTurnSummary || "none"}
- Recent turns:
${turnsSummary || "none"}

User message: "${input.currentInput}"

Call the flashOutput tool with your classification.
If you have a genuine suggestion about where Pro might find related past time slices, include recall_hint.
Omit recall_hint if you have no relevant suggestion.`;

  async function attempt(): Promise<FlashResult> {
    const result = await withTimeout(
      generateText({
        model: deepseek("deepseek-chat"),
        prompt,
        temperature: 0.1,
        tools: { flashOutput: flashOutputSchema },
        toolChoice: "required",
      }),
      FLASH_TIMEOUT_MS
    );

    const toolCall = result.toolCalls?.[0];
    if (toolCall?.toolName === "flashOutput" && (toolCall as Record<string, unknown>).input) {
      const input = (toolCall as Record<string, unknown>).input as {
        intent: string;
        confidence: number;
        intent_switched: boolean;
        needs_more_turns: boolean;
        reasoning: string;
        suggested_topics?: string[];
        recall_hint?: FlashResult["recall_hint"];
      };
      return {
        intent: input.intent,
        confidence: input.confidence,
        intent_switched: input.intent_switched,
        needs_more_turns: input.needs_more_turns,
        reasoning: input.reasoning,
        suggested_topics: input.suggested_topics,
        recall_hint: input.recall_hint,
      };
    }

    throw new Error("Flash did not call the required tool");
  }

  // First attempt
  try {
    return await attempt();
  } catch {
    // Retry once after brief delay
    try {
      await new Promise((r) => setTimeout(r, FLASH_RETRY_DELAY_MS));
      return await attempt();
    } catch {
      return {
        intent: "clarify",
        confidence: 0.3,
        intent_switched: false,
        needs_more_turns: false,
        reasoning: "Flash unavailable, fell back to clarify",
      };
    }
  }
}

/**
 * Hybrid classifier: Flash primary, keyword rules as override.
 * Implements the needs_more_turns expansion loop.
 */
export async function classifyIntentHybrid(
  input: FlashInput,
  maxExpansions: number = 2
): Promise<{
  intent: string;
  confidence: number;
  source: "flash" | "keyword" | "flash_expanded" | "fallback";
  needsMoreTurns: boolean;
  recall_hint?: FlashResult["recall_hint"];
  suggested_topics?: string[];
}> {
  let flashResult = await classifyWithFlash(input);
  let expansions = 0;

  while (flashResult.needs_more_turns && expansions < maxExpansions && input.recentTurns.length > 0) {
    flashResult = await classifyWithFlash(input);
    expansions++;
  }

  const keywordIntent = matchKeywords(input.currentInput);
  if (keywordIntent && flashResult.confidence < 0.8) {
    return {
      intent: keywordIntent,
      confidence: 1.0,
      source: "keyword",
      needsMoreTurns: false,
      recall_hint: flashResult.recall_hint,
      suggested_topics: flashResult.suggested_topics,
    };
  }

  return {
    intent: flashResult.intent,
    confidence: flashResult.confidence,
    source: expansions > 0 ? "flash_expanded" : "flash",
    needsMoreTurns: flashResult.needs_more_turns,
    recall_hint: flashResult.recall_hint,
    suggested_topics: flashResult.suggested_topics,
  };
}
