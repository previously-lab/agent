/** Project-owned chat protocol. Durable streams and saved UI state use the
 * same vocabulary, independently of the model provider or its client library. */
export type ProviderMetadata = Record<string, Record<string, unknown>>;

export type UIMessagePart =
  | { type: "text"; text: string; state?: "streaming" | "done"; providerMetadata?: ProviderMetadata }
  | { type: "reasoning"; text: string; state?: "streaming" | "done"; providerMetadata?: ProviderMetadata }
  | { type: "file"; mediaType: string; url: string; filename?: string }
  | { type: "step-start" }
  | { type: `data-${string}`; id?: string; data: unknown }
  | { type: "dynamic-tool" | `tool-${string}`; toolCallId: string; toolName?: string; state: string; input?: unknown; output?: unknown; errorText?: string }
  | { type: "source-url"; sourceId: string; url: string; title?: string }
  | { type: "source-document"; sourceId: string; mediaType: string; title: string; filename?: string };

export interface UIMessage {
  id: string;
  role: "system" | "user" | "assistant";
  metadata?: unknown;
  parts: UIMessagePart[];
}

export interface UIMessageChunk {
  type: string;
  id?: string;
  messageId?: string;
  messageMetadata?: unknown;
  delta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  inputTextDelta?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  data?: unknown;
  transient?: boolean;
  providerMetadata?: ProviderMetadata;
  finishReason?: string;
}
