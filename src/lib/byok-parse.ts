export const DEFAULT_COMPATIBLE_CHAT_MODEL = "deepseek-v4.1-flash";

/** Credentials remain server-side; never put this type in workflow input. */
export interface ClientByok {
  provider: "deepseek"; apiKey: string; model: "deepseek-flash";
  /** Explicit OpenAI-compatible Chat route, independent of native DeepSeek. */
  chatHost?: string; chatKey?: string; chatModel?: string;
}

export function normalizeCompatibleChatHost(host: string): string {
  const normalized = host.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Chat Host must be HTTPS, without credentials, query or fragment. HTTP is allowed only on localhost.");
  }
  return normalized;
}

export function compatibleChatEndpoint(host: string): string {
  return `${normalizeCompatibleChatHost(host).replace(/\/chat\/completions$/, "")}/chat/completions`;
}

/** Read old DeepSeek configurations without rewriting the user's file. */
export function parseByok(raw: unknown): ClientByok | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.provider !== "deepseek" || typeof b.apiKey !== "string" || !b.apiKey.trim()) return null;
  // Never send a key issued for a custom proxy to the official endpoint.
  if (b.baseUrl !== undefined && b.baseUrl !== "" &&
      (typeof b.baseUrl !== "string" || !/^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(b.baseUrl))) return null;
  const parsed: ClientByok = { provider: "deepseek", apiKey: b.apiKey.trim(), model: "deepseek-flash" };
  if (b.chatHost !== undefined || b.chatKey !== undefined || b.chatModel !== undefined) {
    if (typeof b.chatHost !== "string" || !b.chatHost.trim() || typeof b.chatKey !== "string" || !b.chatKey.trim()) return null;
    try { parsed.chatHost = normalizeCompatibleChatHost(b.chatHost); } catch { return null; }
    parsed.chatKey = b.chatKey.trim();
    if (b.chatModel !== undefined && typeof b.chatModel !== "string") return null;
    parsed.chatModel = typeof b.chatModel === "string" && b.chatModel.trim()
      ? b.chatModel.trim() : DEFAULT_COMPATIBLE_CHAT_MODEL;
  }
  return parsed;
}
