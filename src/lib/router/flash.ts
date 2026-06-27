import { generateObject } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod/v4";
import { matchKeywords, type IntentStrategy } from "./speed-index";

const intentResultSchema = z.object({
  intent: z.string().describe("The classified intent label"),
  confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
  intent_switched: z.boolean().describe("Whether intent changed from previous session intent"),
  needs_more_turns: z.boolean().describe("Whether more conversation history is needed to classify accurately"),
  reasoning: z.string().describe("One-line reasoning for the classification"),
});

export interface FlashResult {
  intent: string;
  confidence: number;
  intent_switched: boolean;
  needs_more_turns: boolean;
  reasoning: string;
}

export interface FlashInput {
  currentInput: string;
  lastTurnSummary: string;
  sessionIntent: string;
  recentTurns: Array<{ role: string; content: string }>;
}

/**
 * Classify user intent using a lightweight model call (generateObject).
 * Flash is told: you are a classifier, not a reasoning agent.
 */
export async function classifyWithFlash(input: FlashInput): Promise<FlashResult> {
  const turnsSummary = input.recentTurns
    .slice(-3)
    .map((t) => `${t.role}: ${t.content.slice(0, 150)}`)
    .join("\n");

  const prompt = `Classify the user's intent based on their latest message and conversation context.

Available intents: code_debug, code_write, explain, chat, review, clarify

Context:
- Session intent: ${input.sessionIntent}
- Last turn summary: ${input.lastTurnSummary || "none"}
- Recent turns:
${turnsSummary || "none"}

User's latest message: "${input.currentInput}"

Classify the intent. If the context is insufficient to confidently classify (e.g., user message is ambiguous and there's not enough history), set needs_more_turns: true.`;

  try {
    const result = await generateObject({
      model: deepseek("deepseek-chat"),
      schema: intentResultSchema,
      prompt,
      temperature: 0.1, // low temperature for classification
    });

    return result.object;
  } catch {
    // Flash unavailable — return low-confidence fallback
    return {
      intent: "clarify",
      confidence: 0.3,
      intent_switched: false,
      needs_more_turns: false,
      reasoning: "Flash model unavailable, fell back to clarify",
    };
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
}> {
  // Step 1: Try Flash with current context
  let flashResult = await classifyWithFlash(input);
  let expansions = 0;

  // Step 2: If Flash needs more context, expand turns and retry
  while (flashResult.needs_more_turns && expansions < maxExpansions && input.recentTurns.length > 0) {
    // The engineering layer already has all turns — Flash already saw all available turns
    // If it still needs more, that means we don't have more to give
    flashResult = await classifyWithFlash(input);
    expansions++;
  }

  // Step 3: Keyword rules override low-confidence Flash
  const keywordIntent = matchKeywords(input.currentInput);
  if (keywordIntent && flashResult.confidence < 0.8) {
    return {
      intent: keywordIntent,
      confidence: 1.0,
      source: "keyword",
      needsMoreTurns: false,
    };
  }

  // Step 4: Use Flash result
  return {
    intent: flashResult.intent,
    confidence: flashResult.confidence,
    source: expansions > 0 ? "flash_expanded" : "flash",
    needsMoreTurns: flashResult.needs_more_turns,
  };
}
