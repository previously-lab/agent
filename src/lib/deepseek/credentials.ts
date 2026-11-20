import { readClientByokSync } from "@/lib/byok-sync";
import { isClientMode } from "@/lib/mode";
import { compatibleChatEndpoint, DEFAULT_COMPATIBLE_CHAT_MODEL } from "@/lib/byok-parse";

/** Read credentials only at the HTTP boundary, never in workflow arguments. */
export function deepseekApiKey(): string {
  if (isClientMode()) {
    const byok = readClientByokSync();
    if (byok?.provider === "deepseek" && byok.apiKey.trim()) return byok.apiKey.trim();
    const inheritedKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (inheritedKey) return inheritedKey;
    throw new Error("Configure a DeepSeek API key in the client settings.");
  }
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured.");
  return key;
}

export interface CompatibleChatRoute {
  host: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

/** The alternate route is all-or-nothing: never send the official key there. */
export function compatibleChatRoute(): CompatibleChatRoute | undefined {
  const byok = isClientMode() ? readClientByokSync() : null;
  const host = byok?.chatHost?.trim() || process.env.CHAT_API_HOST?.trim();
  const apiKey = byok?.chatKey?.trim() || process.env.CHAT_API_KEY?.trim();
  if (!host && !apiKey) return undefined;
  if (!host || !apiKey) throw new Error("CHAT_API_HOST and CHAT_API_KEY (or the equivalent client settings) must be configured together.");
  const model = byok?.chatModel?.trim() || process.env.CHAT_API_MODEL?.trim() || DEFAULT_COMPATIBLE_CHAT_MODEL;
  return { host, endpoint: compatibleChatEndpoint(host), model, apiKey };
}

/** Availability reads expose no credential and never fail a settings page. */
export function hasCompatibleChatRoute(): boolean {
  try { return compatibleChatRoute() !== undefined; } catch { return false; }
}

/** Native DeepSeek capabilities require the primary key, not a Chat-only route. */
export function hasDeepSeekCredential(): boolean {
  const byok = isClientMode() ? readClientByokSync() : null;
  return Boolean(byok?.provider === "deepseek" && byok.apiKey.trim() || process.env.DEEPSEEK_API_KEY?.trim());
}
