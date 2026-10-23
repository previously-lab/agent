import { DEEPSEEK_MODEL, ROLE_EFFORT, type DeepSeekRole, type ReasoningEffort } from "./types";

export type Role = DeepSeekRole;
export type RoleProfile = { model: typeof DEEPSEEK_MODEL; thinking: true; reasoningEffort: ReasoningEffort };
/** Server-owned role settings, never a runtime model selector. */
export const ROLE_PROFILES: Record<Role, RoleProfile> = Object.fromEntries(
  Object.entries(ROLE_EFFORT).map(([role, reasoningEffort]) => [role, { model: DEEPSEEK_MODEL, thinking: true, reasoningEffort }]),
) as Record<Role, RoleProfile>;
export function roleProfile(role: Role = "chat"): RoleProfile { return { ...ROLE_PROFILES[role] }; }
