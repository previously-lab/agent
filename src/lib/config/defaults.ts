import type { UserConfig } from "./types";

/**
 * Hard defaults. When `memory/user/config.json` is missing or a field is
 * absent, these values apply. Keep them conservative — they ship to every
 * user who hasn't customized their config.
 */
export const DEFAULTS: UserConfig = {
  slicing: {
    maxTurnsPerSlice: 20,
    timeSilenceMinutes: 30,
  },
  context: {
    recentTurnsLimit: 20,
    tokenBudget: 12000,
  },
  model: {
    provider: "deepseek-chat",
    thinking: true,
  },
};

/**
 * Shallow-merge partial user overrides onto defaults. Only the keys present in
 * `overrides` are applied; missing keys stay at their default values.
 */
export function mergeConfig(overrides: Partial<UserConfig>): UserConfig {
  return {
    slicing: { ...DEFAULTS.slicing, ...overrides.slicing },
    context: { ...DEFAULTS.context, ...overrides.context },
    model: { ...DEFAULTS.model, ...overrides.model },
  };
}
