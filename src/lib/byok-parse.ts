/** Credentials remain server-side; never put this type in workflow input. */
export interface ClientByok {
  provider: "deepseek"; apiKey: string; model: "deepseek-flash";
}
/** Read old DeepSeek configurations without rewriting the user's file. */
export function parseByok(raw: unknown): ClientByok | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.provider !== "deepseek" || typeof b.apiKey !== "string" || !b.apiKey.trim()) return null;
  // Never send a key issued for a custom proxy to the official endpoint.
  if (b.baseUrl !== undefined && b.baseUrl !== "" &&
      (typeof b.baseUrl !== "string" || !/^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(b.baseUrl))) return null;
  return { provider: "deepseek", apiKey: b.apiKey.trim(), model: "deepseek-flash" };
}
