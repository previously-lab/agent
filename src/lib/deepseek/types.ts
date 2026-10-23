import type { z } from "zod";

export const DEEPSEEK_MODEL = "deepseek-flash";
export type DeepSeekRole = "chat" | "recall" | "summary" | "reflection" | "search" | "think" | "vision" | "companion" | "direction";
export type ReasoningEffort = "low" | "high" | "max";
export const ROLE_EFFORT: Record<DeepSeekRole, ReasoningEffort> = {
  chat: "high", recall: "low", summary: "low", reflection: "max", search: "high",
  think: "max", vision: "low", companion: "low", direction: "high",
};

export interface TextPart { type: "text"; text: string }
export interface ReasoningPart { type: "reasoning"; text: string; providerOptions?: Record<string, unknown>; providerMetadata?: Record<string, unknown> }
export interface ImagePart { type: "image"; image: string | URL | Uint8Array; mediaType?: string }
export interface FilePart { type: "file"; data: string | URL | Uint8Array; mediaType: string; filename?: string }
export interface ToolCallPart { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
export type ToolResultOutput = { type: "text" | "error-text"; value: string } | { type: "json" | "error-json"; value: unknown };
export interface ToolResultPart { type: "tool-result"; toolCallId: string; toolName: string; output: ToolResultOutput; isError?: boolean }
export type ModelPart = TextPart | ReasoningPart | ImagePart | FilePart | ToolCallPart | ToolResultPart;
export interface NativeToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<Record<string, unknown>>;
  reasoning_content?: string | null;
  tool_calls?: NativeToolCall[];
  tool_call_id?: string;
}
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ModelPart[];
  /** Exact model message, kept across tool rounds and durable checkpoints. */
  deepseek?: NativeMessage;
  reasoning_content?: string;
  providerOptions?: Record<string, unknown>;
}
export type ToolExecutionOptions<Context = unknown> = {
  toolCallId: string;
  messages: ModelMessage[];
  context: Context;
  abortSignal?: AbortSignal;
};
export interface Tool<Input = unknown, Output = unknown, Context = unknown> {
  description?: string;
  inputSchema: z.ZodType<Input>;
  contextSchema?: z.ZodType<Context>;
  execute?(input: Input, options: ToolExecutionOptions<Context>): Output | PromiseLike<Output>;
}
export type ToolSet = Record<string, Tool>;
export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };
export interface ToolCall { toolCallId: string; toolName: string; input: unknown; invalid?: boolean; error?: unknown }
export interface ToolResult { toolCallId: string; toolName: string; output?: unknown; error?: unknown }
export interface TokenUsage {
  inputTokens: number; outputTokens: number; totalTokens: number;
  reasoningTokens: number; cachedInputTokens: number; uncachedInputTokens: number;
}
/** App-owned stream events. Delta events retain text for internal progress hooks. */
export interface ModelCallStreamPart {
  type: string; id?: string; delta?: string; text?: string;
  protocol?: "deepseek-v1";
  toolCallId?: string; toolName?: string; inputTextDelta?: string;
  input?: unknown; output?: unknown; error?: unknown; errorText?: string;
  finishReason?: string; usage?: TokenUsage;
  data?: unknown; transient?: boolean;
}
export interface StepResult<Tools extends ToolSet = ToolSet> {
  text: string; reasoning: ReasoningPart[]; reasoningText: string;
  toolCalls: ToolCall[]; toolResults: ToolResult[]; content: ModelPart[];
  finishReason: string; rawFinishReason: string; usage: TokenUsage;
  response: { messages: ModelMessage[] }; warnings: unknown[];
  stepNumber: number;
  /** Type-only association; no tool functions cross a step boundary. */
  readonly tools?: Tools;
}
export interface AgentResult<Tools extends ToolSet = ToolSet> {
  text: string; reasoningText: string; toolCalls: ToolCall[]; toolResults: ToolResult[];
  messages: ModelMessage[]; steps: StepResult<Tools>[]; finishReason: string;
  usage: TokenUsage; totalUsage: TokenUsage; warnings: unknown[];
  sources: Array<{ sourceType: string; url?: string; title?: string }>;
}
export type StopCondition = ((options: { steps: StepResult[] }) => boolean) & { maxSteps?: number };
export type PrepareStepFunction<Tools extends ToolSet = ToolSet> = (options: {
  stepNumber: number; steps: StepResult<Tools>[]; messages: ModelMessage[];
}) => void | { system?: string; toolChoice?: ToolChoice; activeTools?: Array<keyof Tools> } | Promise<void | { system?: string; toolChoice?: ToolChoice; activeTools?: Array<keyof Tools> }>;
export interface AgentOptions<Tools extends ToolSet = ToolSet> {
  role?: DeepSeekRole; system?: string; instructions?: string;
  prompt?: string; messages?: ModelMessage[];
  tools?: Tools; toolsContext?: Record<string, unknown>;
  toolChoice?: ToolChoice; stopWhen?: StopCondition | StopCondition[];
  prepareStep?: PrepareStepFunction<Tools>;
  thinking?: boolean; reasoningEffort?: ReasoningEffort;
  temperature?: number; timeout?: number; abortSignal?: AbortSignal;
  maxRetries?: number;
  onChunk?: (event: { chunk: ModelCallStreamPart }) => void | Promise<void>;
  onError?: (event: { error: unknown }) => void | Promise<void>;
  onStepEnd?: (step: StepResult<Tools>) => void | Promise<void>;
  onToolExecutionStart?: (event: { toolCall: ToolCall }) => void | Promise<void>;
  writable?: WritableStream<ModelCallStreamPart>; sendFinish?: boolean; preventClose?: boolean;
}
export interface SerializedTool { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface ModelRequest {
  messages: NativeMessage[]; tools?: SerializedTool[]; toolChoice?: ToolChoice;
  thinking: boolean; reasoningEffort: ReasoningEffort; temperature?: number;
  callId: string; timeoutMs?: number; maxRetries?: number;
}
export interface ModelResponse {
  message: NativeMessage; toolCalls: NativeToolCall[]; finishReason: string;
  usage: TokenUsage;
  /** A failed stream is checkpointed before the orchestrator reports failure. */
  error?: { message: string; statusCode?: number };
}
