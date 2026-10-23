/** Fixed deployment model. Credentials are resolved inside model steps only. */
import { readClientByokSync } from "../byok-sync";
import { isClientMode } from "../mode";

import { DEEPSEEK_MODEL } from "@/lib/deepseek/types";
export { DEEPSEEK_MODEL };
export interface ModelCapabilities { thinking: boolean; vision: boolean; maxTokens: number; }
export interface ModelConfig {
  id: string; name: string; provider: string; providerName: string;
  sdk: "deepseek"; envKey: string; baseURL?: string;
  capabilities: ModelCapabilities; defaultThinking: boolean;
  defaultEffort: "low" | "medium" | "high";
}
export const FIXED_MODEL: ModelConfig = {
  id: DEEPSEEK_MODEL, name: "DeepSeek Flash", provider: "deepseek",
  providerName: "DeepSeek", sdk: "deepseek", envKey: "DEEPSEEK_API_KEY",
  baseURL: "https://api.deepseek.com",
  capabilities: { thinking: true, vision: true, maxTokens: 1_000_000 },
  defaultThinking: true,
  // The actual tiers are low/high/max; high is the middle tier.
  defaultEffort: "high",
};
export const ALL_MODELS: ModelConfig[] = [FIXED_MODEL];
export function getAvailableModels(): ModelConfig[] {
  const configured = isClientMode()
    ? !!readClientByokSync()?.apiKey || !!process.env.DEEPSEEK_API_KEY?.trim()
    : !!process.env.DEEPSEEK_API_KEY?.trim();
  return configured ? [FIXED_MODEL] : [];
}
/** Old preferences never re-enable a retired provider or runtime selector. */
export function getModel(_id: string): ModelConfig { return FIXED_MODEL; }
export function resolveModelId(_id: string): string { return DEEPSEEK_MODEL; }
export function getDefaultModelId(): string { return DEEPSEEK_MODEL; }
