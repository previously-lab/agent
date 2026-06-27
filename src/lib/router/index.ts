import { matchKeywords, getStrategy, type IntentStrategy } from "./speed-index";
import { classifyIntentHybrid, type FlashInput } from "./flash";

export interface IntentResult {
  intent: string;
  switched: boolean;
  confidence: number;
  source: "flash" | "flash_expanded" | "keyword" | "fallback";
  needsMoreTurns?: boolean;
}

/**
 * Classify intent using hybrid approach: Flash + keyword rules.
 * This is the main entry point — used by the Chat API.
 */
export async function classifyIntent(
  input: FlashInput
): Promise<IntentResult> {
  const result = await classifyIntentHybrid(input);

  return {
    intent: result.intent,
    switched: input.sessionIntent !== result.intent && input.sessionIntent !== "clarify",
    confidence: result.confidence,
    source: result.source,
    needsMoreTurns: result.needsMoreTurns,
  };
}

/**
 * Simple keyword-only classification (for use when Flash is not needed).
 */
export function classifyIntentKeywords(input: string): { intent: string; source: "keyword" | "fallback" } {
  const keywordIntent = matchKeywords(input);
  if (keywordIntent) {
    return { intent: keywordIntent, source: "keyword" };
  }
  return { intent: "clarify", source: "fallback" };
}

/**
 * Get the full intent pipeline result: intent + strategy.
 */
export async function resolveIntent(input: FlashInput): Promise<{
  intent: IntentResult;
  strategy: IntentStrategy;
}> {
  const intent = await classifyIntent(input);
  const strategy = getStrategy(intent.intent);
  return { intent, strategy };
}

export { getStrategy, matchKeywords, getAvailableIntents, getSpeedIndex } from "./speed-index";
