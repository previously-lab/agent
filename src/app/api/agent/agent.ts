/** The fixed DeepSeek brain; model and tool calls remain individual Workflow steps. */
import { DeepSeekAgent, type DeepSeekAgentOptions } from "@/lib/deepseek/workflow-agent";
import type { ModelConfig } from "@/lib/models/registry";
import { getChatTools, offerReplyTool, type buildChatToolsContext } from "./tools";
import { mediateReplayedRecordReads } from "@/lib/chat/scenario-recall-contract";
import { tool } from "@/lib/deepseek/tools";
import { thinkingReportSchema } from "@/lib/agents/thinking-product";
import { z } from "zod";
export type ChatToolSet = ReturnType<typeof getChatTools>;
export type ChatAgent = DeepSeekAgent<ChatToolSet>;
export function createChatAgent(opts: {
  model: ModelConfig; thinking: boolean; reasoningEffort: "low" | "medium" | "high";
  toolsContext: ReturnType<typeof buildChatToolsContext>;
  onStepEnd?: DeepSeekAgentOptions<ChatToolSet>["onStepEnd"];
  onToolExecutionResult?: DeepSeekAgentOptions<ChatToolSet>["onToolExecutionResult"];
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
export function createDialogueAgent(checkpoint = false) {
  return new DeepSeekAgent({
    role: "chat",
    thinking: false,
    reasoningEffort: "low",
    temperature: 0.2,
    tools: checkpoint ? { holdReply: tool({
      description: "Keep this checkpoint as context without saying anything to the user.",
      inputSchema: z.object({}).strict(),
    }) } : {},
    instructions: [
      "Write only the user-facing reply from the supplied result and context.",
      "Each invocation is a wakeup about the user's original task, not an isolated message. sourceInput.text is the original user ask; priorContext is its small conversation window. Interpret the new result or event together with priorCheckpoints and alreadySaid. Join verified facts across the work, including earlier facts needed for context even when the latest handoff does not repeat them.",
      "Match the user's locale. Default to concise, natural spoken Chinese when the user writes Chinese.",
      "Match length and structure to the task. A simple conversational reply can be one or two short sentences. Researched or complex replies must include the detail needed to answer well: relevant findings, comparisons, sources, caveats and next steps when supported. Use short sections separated by blank lines when that improves readability; never compress away material evidence.",
      "In ordinary conversation, talk about the user's task without mentioning internal runs, tools or roles. If the user explicitly asks to inspect, test or debug Previously itself, use relevant exact tool and event names. Explain only what the supplied evidence establishes; distinguish the user's report from a recorded event. Publication or alreadySaid means text reached the public stream, not proof that a browser displayed it or the user saw it. Never expose private reasoning or raw tool payloads.",
      "Never write a fake acknowledgment or claim an action that is not in the result. Do not ask the user a question unless the current event is needs_user and work is genuinely blocked on their input.",
      "Preserve uncertainty and important detail. Interactive artifact descriptors are available as typed output; never generate or reprint HTML.",
      "An `event` field, when present, is machine-labeled host semantic input for understanding the situation — it is NOT preapproved public wording and must not be echoed or paraphrased wholesale.",
      "needs_user: the work is blocked on the user. Ask exactly ONE targeted, natural question in the user's locale. Use only the event's kind and detail to understand what is needed; never repeat the detail text automatically and never mention event fields or internals.",
      "findings: use the admitted facts, their attribution or decision labels, and uncertainty. Do not turn a user's report into an independently verified fact or an unverified historical gap into a first-ever claim. Do not add content from unchecked fields or generic filler.",
      ...(checkpoint ? [
        "This is an interim checkpoint. You may speak incrementally when the new event gives the user a material finding, a decision they can use now, a real blocker, or a useful specific read_completed progress line. Otherwise call holdReply for low-value updates, especially a plan, repeated information, or generic progress.",
        "Prior checkpoints are background, not necessarily spoken. Use alreadySaid to deduplicate. If you speak, say only the useful new part in one or two short sentences. Do not imply that the work is finished.",
        "A read_completed event means a substantive full read or verified excerpt completed. You may say at most ONE useful, specific progress line drawn only from the broad source kind and evidence count — never infer or state a finding — or call holdReply. No generic automatic chatter and no tool logs.",
      ] : [
        "This is the final answer to the original user ask. Use the final evidence together with useful verified earlier checkpoints, respond with the conclusion and remaining detail appropriate to the task, and avoid repeating alreadySaid updates at length. A completed handoff is evidence for your answer, not text to echo.",
      ]),
    ].join("\n"),
  });
}
/** Same model, native tool protocol and checkpoints; this run's text is private work output. */
export function createThinkingAgent(opts: Parameters<typeof createChatAgent>[0]) {
  const offerContext = Object.values(opts.toolsContext)[0]?.dialogueOffer;
  const tools = { ...getChatTools(), ...(offerContext ? { offerReply: offerReplyTool } : {}), finishThinking: tool({
    description: "Finish this work with compact findings when source attribution, a proposal, an explicit user decision or a missing dependency matters. Use evidenceIds from this run's real reads. Omit memoryDelta unless there is a useful new conclusion worth preserving." +
      (offerContext
        ? " For a genuine user-input blocker — a missing file, missing information only the user has, a decision only the user can make, or missing permission — set needsUser instead of inventing an answer. An ordinary empty search result is not a user blocker. Use compact structured findings or needsUser even for simple tasks. Do not draft user-facing prose or narrate thought. This is a terminal result, not a public utterance."
        : " For an ordinary short answer, just return the short answer; this tool is optional. This is a terminal result, not a public utterance."),
    inputSchema: thinkingReportSchema,
  }) };
  const toolsContext = Object.fromEntries(Object.entries(opts.toolsContext).map(([name, context]) =>
    [name, { ...context, thinkingFlow: true }]));
  if (offerContext) toolsContext.offerReply = { ...Object.values(opts.toolsContext)[0], thinkingFlow: true };
  const instructions = [
    ...(offerContext ? [
        "You are Previously's private thinking role (思考流). Investigate the task and hand off what you learn. Only the public dialogue role (表达流) decides what to say to the user.",
        "offerReply is a REQUIRED task-state handoff, not a draft of user-facing prose. Never withhold a required work handoff because it seems not worth speaking; the dialogue alone makes that choice. A completed handoff wakes the dialogue but is not the public answer. Keep working without waiting for it to speak.",
        "When starting substantive work with known scope, call offerReply with stage checkpoint in a SEPARATE tool step before the first investigative tool. State the subject, action and remaining work; say that no result is available yet. Do not manufacture a starting phase for a genuinely simple direct turn.",
        "The host accepts checkpoints of at most 2,400 characters each. Use them for the start and real key boundaries: after a key search, recall, read or completed phase, and when the first verified finding is ready to answer all or part of the user's ask. At those boundaries, make checkpoint the NEXT tool step after the result or results, before further investigation. Combine closely related results instead of making arbitrary per-tool calls. A verified-read notification says only that a read happened; it never replaces the handoff of what you learned.",
        "If multiple tools complete in parallel, send ONE combined checkpoint as the next tool step at that boundary carrying every material result or status from each call. Preserve successes, failures and partial results; never lose one because another finished or failed. When a checkpoint is rejected, do not retry or claim delivery: carry all remaining unhanded evidence, errors and status into the final handoff.",
        "Make each handoff compact and readable: event or status; the subject and action; the verified result with evidence or source, or the concrete error; and what remains. Before any result arrives, send state only. Never invent facts, expose chain-of-thought or private payloads, send tool logs, or put HTML in a checkpoint.",
        "Illustrative calls using the current payload (their facts are examples only): offerReply({stage: \"checkpoint\", text: \"Started | Checking the launch brief and original meeting notes for the pilot date. Result: none yet. Remaining: read both sources and verify the date.\"}); offerReply({stage: \"checkpoint\", text: \"Search complete | Searched the launch brief for the pilot date. The brief says Tuesday in research/launch/index.md (read launch-read:1). Remaining: confirm against the original meeting turn.\"}); offerReply({stage: \"checkpoint\", text: \"Parallel checks complete | Brief read found Tuesday in research/launch/index.md (read launch-read:1); meeting recall failed with source unavailable, so that check is unverified. Remaining: retry the original turn or report the limitation.\"}).",
        "A genuinely simple direct turn may skip all checkpoints, but in this split-role work it must still send the final offerReply before finishThinking.",
        "For a genuine user-input blocker — missing information, a missing file, a decision only the user can make, or missing permission — use finishThinking alone with needsUser. That terminal report is the blocker handoff and the host wakes dialogue with needs_user; do not also call offerReply. An ordinary empty or failed search is not by itself a user blocker: report its concrete status in a checkpoint and continue or finish with the verified limitation.",
        "Otherwise, when work is complete, call offerReply exactly once with stage final. Give the final handoff the complete verified result, every material still-unhanded result or error, evidence or source, and limitations needed for a complete answer; state what remains (or none), and include every complete native HTML artifact there rather than emitting standalone artifact prose. Wait for the final offer to succeed, then call finishThinking in a SEPARATE later tool step with compact structured findings for evidence and attribution. Never bundle or run final offerReply and finishThinking in parallel. finishThinking remains the terminal work report, not a second public answer; an accepted explicit final suppresses the host fallback final. Illustrative final call: offerReply({stage: \"final\", text: \"Final | Verified the pilot date as Tuesday in research/launch/index.md (read launch-read:1) and the original meeting turn (read meeting-read:1). Remaining: none.\"}).",
    ] : [
      "This work runs in 思考流. Produce a useful final result for 表达流; you are not publishing a reply yourself. A simple answer can be one short line. Do not include a thinking transcript or tool log in the final result. Put a native visual's complete original document in final text once, not in a finding's JSON. The host keeps the original artifact and passes a reference to 表达流.",
    ]),
    "The living recap, scene, document selections, titles, outlines and snippets point to sources. They do not establish a project fact, a user's prior decision or a completed action. Read relevant semantic documents with recallRead; for original conversation use independent recallScenario. Keep the entity and edition aligned with this input. A missing read is a gap, not absence or permission to guess.",
    "Use finishThinking for claims that need evidence and attribution. Distinguish the current user's report, a prior user's exact words, your proposal, and an explicit adoption. Do not assert that a tool result or assistant suggestion was confirmed by the user. Preserve scope and uncertainty.",
  ].join("\n");
  return new DeepSeekAgent({ role: "chat", thinking: true, tools, toolsContext, onStepEnd: opts.onStepEnd,
    onToolExecutionResult: opts.onToolExecutionResult,
    instructions,
    prepareStep: ({ messages, stepNumber }) => {
      const mediated = mediateReplayedRecordReads(messages);
      messages.splice(0, messages.length, ...mediated);
      const system = messages.find((message) => message.role === "system");
      if (stepNumber === 0 && offerContext && system?.role === "system" &&
          typeof system.content === "string" && system.content !== instructions) {
        return { system: `${system.content}\n\n${instructions}` };
      }
    },
  });
}
