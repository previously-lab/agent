import speedIndexRaw from "../../../config/speed-index.json";

export interface IntentStrategy {
  keywords?: string[];
  memory_types?: string[];
  tags?: string[];
  max_nodes: number;
  include_recent_turns: number;
  loop_mode: boolean;
  max_iterations: number;
  complexity?: string;
}

interface SpeedIndex {
  intents: Record<string, IntentStrategy>;
  fallback: IntentStrategy;
}

const speedIndex = speedIndexRaw as SpeedIndex;

/**
 * Get the memory loading strategy for a given intent.
 */
export function getStrategy(intent: string): IntentStrategy {
  const strategy = speedIndex.intents[intent];
  if (strategy) return strategy;

  // Return fallback
  return {
    ...speedIndex.fallback,
  };
}

/**
 * Check if any keyword rules match the query.
 * Returns the matched intent name, or null.
 */
export function matchKeywords(query: string): string | null {
  const lowerQuery = query.toLowerCase();

  for (const [intent, strategy] of Object.entries(speedIndex.intents)) {
    if (strategy.keywords) {
      for (const kw of strategy.keywords) {
        if (lowerQuery.includes(kw.toLowerCase())) {
          return intent;
        }
      }
    }
  }

  return null;
}

/**
 * Get all available intents.
 */
export function getAvailableIntents(): string[] {
  return Object.keys(speedIndex.intents);
}

/**
 * Get the raw speed index (for inspection).
 */
export function getSpeedIndex(): SpeedIndex {
  return speedIndex;
}
