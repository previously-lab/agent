import { matchKeywords, getStrategy, type IntentStrategy } from "./speed-index";

export interface IntentResult {
  intent: string;
  switched: boolean;
  confidence: number;
  source: "flash" | "keyword" | "fallback";
}

/**
 * Classify user intent using keyword rules (MVP: no Flash model call).
 *
 * M3 MVP uses keyword matching only — Flash model integration
 * is deferred until we have a working end-to-end pipeline.
 */
export function classifyIntent(
  input: string,
  _summary?: string
): IntentResult {
  // 1. Try keyword rules first (deterministic, zero latency)
  const keywordIntent = matchKeywords(input);
  if (keywordIntent) {
    return {
      intent: keywordIntent,
      switched: false,
      confidence: 1.0,
      source: "keyword",
    };
  }

  // 2. Fallback
  return {
    intent: "clarify",
    switched: false,
    confidence: 0.5,
    source: "fallback",
  };
}

/**
 * Get the full intent pipeline result: intent + strategy.
 */
export function resolveIntent(input: string, summary?: string): {
  intent: IntentResult;
  strategy: IntentStrategy;
} {
  const intent = classifyIntent(input, summary);
  const strategy = getStrategy(intent.intent);
  return { intent, strategy };
}

export { getStrategy, matchKeywords, getAvailableIntents, getSpeedIndex } from "./speed-index";
