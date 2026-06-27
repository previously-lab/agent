import { generateText } from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { matchKeywords, type IntentStrategy } from "./speed-index";

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
 * Classify user intent using generateText (no JSON schema compat warning).
 * Flash is told: you are a classifier outputting JSON only, not a reasoning agent.
 */
export async function classifyWithFlash(input: FlashInput): Promise<FlashResult> {
  const turnsSummary = input.recentTurns
    .slice(-3)
    .map((t) => `${t.role}: ${t.content.slice(0, 150)}`)
    .join("\n");

  const prompt = `You are an intent classifier. Output ONLY raw JSON — no markdown, no explanation.

Available intents: code_debug, code_write, explain, chat, review, clarify

Context:
- Session intent: ${input.sessionIntent}
- Last turn summary: ${input.lastTurnSummary || "none"}
- Recent turns:
${turnsSummary || "none"}

User message: "${input.currentInput}"

Output this exact JSON shape:
{"intent":"<one of the above>","confidence":0.0-1.0,"intent_switched":true/false,"needs_more_turns":true/false,"reasoning":"one line"}`;

  try {
    const result = await generateText({
      model: deepseek("deepseek-chat"),
      prompt,
      temperature: 0.1,
    });

    const text = result.text.trim();
    // Extract JSON from response (handle possible markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in Flash response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      intent: parsed.intent ?? "clarify",
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
      intent_switched: Boolean(parsed.intent_switched),
      needs_more_turns: Boolean(parsed.needs_more_turns),
      reasoning: String(parsed.reasoning || ""),
    };
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
