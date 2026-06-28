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
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 65536 },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    capabilities: { thinking: true, vision: false, maxTokens: 65536 },
  },
];

export function getModel(id: string): ModelConfig | undefined {
  return DEFAULT_MODELS.find((m) => m.id === id);
}

export function getDefaultModel(): ModelConfig {
  return DEFAULT_MODELS[0];
}

export function modelSupportsThinking(id: string): boolean {
  return getModel(id)?.capabilities.thinking ?? false;
}
