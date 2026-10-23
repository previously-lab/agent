import { readClientByokSync } from "@/lib/byok-sync";
import { isClientMode } from "@/lib/mode";

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
