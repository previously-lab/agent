/**
 * Model registry — multi-provider model definitions with capabilities.
 */
export interface ModelCapabilities {
  thinking: boolean;
  vision: boolean;
  maxTokens: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: "deepseek" | "anthropic" | "openai";
  capabilities: ModelCapabilities;
}

export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  },
];

/**
 * Legacy DeepSeek ids retired on 2026-07-24 (they now error upstream). Stored
 * user configs and browser-local settings may still hold them — map onto the
 * V4 successors: chat → Flash, reasoner → Pro (our thinking tier).
 */
const LEGACY_MODEL_IDS: Record<string, string> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
};

export function resolveModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] ?? id;
}

export function getModel(id: string): ModelConfig | undefined {
  return DEFAULT_MODELS.find((m) => m.id === id);
}

export function getDefaultModel(): ModelConfig {
  return DEFAULT_MODELS[0];
}

export function modelSupportsThinking(id: string): boolean {
  return getModel(id)?.capabilities.thinking ?? false;
}
