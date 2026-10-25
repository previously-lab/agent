export const NATIVE_BRIDGE_CHANNEL = "previously-native-reply-v1";
export const NATIVE_FOLLOWUP_MAX_CHARS = 2_000;
export const NATIVE_STATE_MESSAGE_MAX_CHARS = 16_384;

export type NativeFrameMessage =
  | { channel: typeof NATIVE_BRIDGE_CHANNEL; token: string; type: "ready" }
  | { channel: typeof NATIVE_BRIDGE_CHANNEL; token: string; type: "resize"; height: number }
  | { channel: typeof NATIVE_BRIDGE_CHANNEL; token: string; type: "state"; json: string }
  | { channel: typeof NATIVE_BRIDGE_CHANNEL; token: string; type: "followup"; prompt: string }
  | { channel: typeof NATIVE_BRIDGE_CHANNEL; token: string; type: "error"; message: string };

export interface NativeThemeTokens {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  brand: string;
  fontBody: string;
  fontHeading: string;
  fontMono: string;
  colorScheme: "light" | "dark";
}

export type NativeHostMessage =
  | { channel: typeof NATIVE_BRIDGE_CHANNEL; token: string; type: "theme"; theme: NativeThemeTokens };

export function validateNativeFrameMessage(
  data: unknown,
  source: unknown,
  expectedSource: unknown,
  expectedToken: string,
): NativeFrameMessage | null {
  if (!expectedSource || source !== expectedSource || typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.channel !== NATIVE_BRIDGE_CHANNEL || message.token !== expectedToken) return null;
  switch (message.type) {
    case "ready":
      return { channel: NATIVE_BRIDGE_CHANNEL, token: expectedToken, type: "ready" };
    case "resize":
      if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height < 1 || message.height > 32_768) return null;
      return { channel: NATIVE_BRIDGE_CHANNEL, token: expectedToken, type: "resize", height: Math.round(message.height) };
    case "state":
      if (typeof message.json !== "string" || message.json.length > NATIVE_STATE_MESSAGE_MAX_CHARS) return null;
      return { channel: NATIVE_BRIDGE_CHANNEL, token: expectedToken, type: "state", json: message.json };
    case "followup": {
      if (typeof message.prompt !== "string" || message.prompt.length > NATIVE_FOLLOWUP_MAX_CHARS) return null;
      const prompt = message.prompt.trim();
      if (!prompt) return null;
      return { channel: NATIVE_BRIDGE_CHANNEL, token: expectedToken, type: "followup", prompt };
    }
    case "error":
      if (typeof message.message !== "string") return null;
      return { channel: NATIVE_BRIDGE_CHANNEL, token: expectedToken, type: "error", message: message.message.slice(0, 500) };
    default:
      return null;
  }
}
