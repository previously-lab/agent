/** The fixed DeepSeek brain; model and tool calls remain individual Workflow steps. */
import { DeepSeekAgent, type DeepSeekAgentOptions } from "@/lib/deepseek/workflow-agent";
import type { ModelConfig } from "@/lib/models/registry";
import { getChatTools, offerReplyTool, type buildChatToolsContext } from "./tools";
import { mediateReplayedRecordReads } from "@/lib/chat/scenario-recall-contract";
import { tool } from "@/lib/deepseek/tools";
import { thinkingReportSchema } from "@/lib/agents/thinking-product";
export type ChatToolSet = ReturnType<typeof getChatTools>;
export type ChatAgent = DeepSeekAgent<ChatToolSet>;
export function createChatAgent(opts: {
  model: ModelConfig; thinking: boolean; reasoningEffort: "low" | "medium" | "high";
  toolsContext: ReturnType<typeof buildChatToolsContext>;
  onStepEnd?: DeepSeekAgentOptions<ChatToolSet>["onStepEnd"];
}): ChatAgent {
  return new DeepSeekAgent({ role: "chat", thinking: true,
    instructions: "You are the user's personal agent with layered episodic memory. Answer from the provided context; use the memory tools to recall details when needed.",
    tools: getChatTools(), toolsContext: opts.toolsContext, onStepEnd: opts.onStepEnd,
    prepareStep: ({ messages }) => {
      const mediated = mediateReplayedRecordReads(messages);
      messages.splice(0, messages.length, ...mediated);
    } });
}

/** Public wording only: one-shot, non-thinking DeepSeek Chat Completions. */
export function createDialogueAgent() {
  return new DeepSeekAgent({
    role: "chat",
    thinking: false,
    reasoningEffort: "low",
    temperature: 0.2,
    tools: {},
    instructions: [
      "Write only the user-facing reply from the supplied result and context.",
      "Match the user's locale. Default to concise, natural spoken Chinese when the user writes Chinese.",
      "Keep ordinary replies to one or two short sentences. When detail is necessary, use short sections separated by blank lines.",
      "Do not mention runs, tools, thinking, dialogue flow, or internal orchestration. Never write a fake acknowledgment or claim an action that is not in the result.",
      "Preserve uncertainty and important detail. Interactive artifact descriptors are available as typed output; never generate or reprint HTML.",
    ].join("\n"),
  });
}
/** Same model, native tool protocol and checkpoints; this run's text is private work output. */
export function createThinkingAgent(opts: Parameters<typeof createChatAgent>[0]) {
  const offerContext = Object.values(opts.toolsContext)[0]?.dialogueOffer;
  const tools = { ...getChatTools(), ...(offerContext ? { offerReply: offerReplyTool } : {}), finishThinking: tool({
    description: "Finish this work with compact findings when source attribution, a proposal, an explicit user decision or a missing dependency matters. Use evidenceIds from this run's real reads. Omit memoryDelta unless there is a useful new conclusion worth preserving. For an ordinary short answer, just return the short answer; this tool is optional. This is a terminal result, not a public utterance.",
    inputSchema: thinkingReportSchema,
  }) };
  const toolsContext = Object.fromEntries(Object.entries(opts.toolsContext).map(([name, context]) =>
    [name, { ...context, thinkingFlow: true }]));
  if (offerContext) toolsContext.offerReply = { ...Object.values(opts.toolsContext)[0], thinkingFlow: true };
  return new DeepSeekAgent({ role: "chat", thinking: true, tools, toolsContext, onStepEnd: opts.onStepEnd,
    instructions: [
      "This work runs in 思考流. Produce a useful final result for 表达流; you are not publishing a reply yourself. A simple answer can be one short line. Do not include a thinking transcript or tool log in the final result.",
      ...(offerContext ? ["Call offerReply whenever a useful partial or final result is ready. It starts the public dialogue and returns immediately; continue working afterwards when useful. Offer the useful result before finishThinking."] : []),
      "The living recap, scene, document selections, titles, outlines and snippets point to sources. They do not establish a project fact, a user's prior decision or a completed action. Read relevant semantic documents with recallRead; for original conversation use independent recallScenario. Keep the entity and edition aligned with this input. A missing read is a gap, not absence or permission to guess.",
      "Use finishThinking for claims that need evidence and attribution. Distinguish the current user's report, a prior user's exact words, your proposal, and an explicit adoption. Do not assert that a tool result or assistant suggestion was confirmed by the user. Preserve scope and uncertainty. Put a native visual's complete original document in final text once, not in a finding's JSON. The host keeps the original artifact and passes a reference to 表达流.",
    ].join("\n"),
    prepareStep: ({ messages }) => {
      const mediated = mediateReplayedRecordReads(messages);
      messages.splice(0, messages.length, ...mediated);
    },
  });
}
