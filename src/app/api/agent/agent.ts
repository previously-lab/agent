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
export function createDialogueAgent(checkpoint = false, direct = false) {
  return new DeepSeekAgent({
    role: "chat",
    thinking: false,
    reasoningEffort: "low",
    temperature: 0.2,
    tools: {},
    instructions: [
      "You are Previously's public wording layer. Write natural user-facing language from the supplied handoff events. The thinking role owns investigation, factual judgments, and what is still uncertain. You own how to say it.",
      "Each invocation is a wakeup about the original user task. sourceInput.text is the original user ask; priorContext is the public conversation window. Use the current event and priorCheckpoints as your content, and use priorCheckpoints and alreadySaid to keep the conversation continuous and avoid repetition.",
      "Match the user's locale. Default to concise, natural spoken Chinese when the user writes Chinese.",
      "Choose wording, order, length, and structure that fit the task and locale. Carry over the material findings, sources, caveats, and next steps in the events. Turn rough notes or fields into natural prose instead of echoing event labels or formatting.",
      "In ordinary conversation, talk about the user's task without mentioning internal runs, tools or roles. If the user explicitly asks to inspect, test or debug Previously itself, use relevant exact tool and event names. Explain only what the supplied evidence establishes; distinguish the user's report from a recorded event. Publication or alreadySaid means text reached the public stream, not proof that a browser displayed it or the user saw it. Never expose private reasoning or raw tool payloads.",
      "Do not investigate, fact-check, independently resolve disagreements, or add facts or conclusions. Preserve the event's attribution, corrections, and confidence level. If it says something is provisional, unverified, or unknown, say so naturally. Do not ask the user a question unless the current event is needs_user.",
      "Preserve uncertainty and important detail. Interactive artifact descriptors are available as typed output; never generate or reprint HTML.",
      "The event is input for wording, not a draft to quote. An offer_reply event contains the thinking role's handoff notes for the current stage; host events can provide findings or a question that must be asked.",
      "needs_user: the work is blocked on the user. Ask exactly ONE targeted, natural question in the user's locale. Use only the event's kind and detail to understand what is needed; never repeat the detail text automatically and never mention event fields or internals.",
      "findings: keep the reported findings, their attribution and uncertainty. Render them in the user's language without changing their meaning.",
      ...(direct ? [
        "The current work may have been superseded or made irrelevant by a later user input in priorContext. If no public reply is useful now, return empty text. Never invent a reply just because the work completed.",
      ] : []),
      ...(checkpoint ? [
        "This is an interim update intended for the user. Always turn the current handoff into a nonempty reply of one or two natural sentences, including when it only confirms the task or states a plan. Do not decide whether to speak.",
        "Use priorCheckpoints and alreadySaid to keep continuity and avoid repeating earlier wording. Preserve the current update's meaning and uncertainty. Do not imply the work has finished.",
      ] : [
        "This is the final reply for the original ask. Use the final event and relevant earlier handoffs; express their conclusions as supplied, keep material caveats, and avoid repeating alreadySaid at length.",
      ]),
    ].join("\n"),
  });
}
/** Native thinking hands off tool events; the unsplit legacy mode retains its text contract. */
export function createThinkingAgent(opts: Parameters<typeof createChatAgent>[0]) {
  const offerContext = Object.values(opts.toolsContext)[0]?.dialogueOffer;
  const tools = { ...getChatTools(), ...(offerContext ? { offerReply: offerReplyTool } : {}), finishThinking: tool({
    description: "Finish this work with compact findings when source attribution, a proposal, an explicit user decision or a missing dependency matters. Use evidenceIds from this run's real reads. Omit memoryDelta unless there is a useful new conclusion worth preserving." +
      (offerContext
        ? " For a genuine user-input blocker — a missing file, missing information only the user has, a decision only the user can make, or missing permission — set needsUser instead of inventing an answer. An ordinary empty search result is not a user blocker. Use compact structured findings or needsUser even for simple tasks. Leave ordinary assistant content empty. This is the terminal work event."
        : " For an ordinary short answer, just return the short answer; this tool is optional. This is a terminal result, not a public utterance."),
    inputSchema: thinkingReportSchema,
  }) };
  const toolsContext = Object.fromEntries(Object.entries(opts.toolsContext).map(([name, context]) =>
    [name, { ...context, thinkingFlow: true }]));
  if (offerContext) toolsContext.offerReply = { ...Object.values(opts.toolsContext)[0], thinkingFlow: true };
  const instructions = [
    ...(offerContext ? [
        "You are Previously's private thinking role (思考流). You own investigation, factual judgments, evidence, and uncertainty. Emit only tool calls and handoff events. Leave ordinary assistant message content empty on every step, including the last. Do not acknowledge, narrate, or write a complete answer in ordinary message content. Use offerReply and finishThinking for all handoffs; the public dialogue role turns them into human wording.",
        "offerReply is a REQUIRED task-state handoff, not a draft of user-facing prose. Send required work handoffs on time. The dialogue role turns the handoff into user-facing wording. Keep working without waiting for it to speak.",
        "Your FIRST action after receiving every user task in this split role MUST be offerReply with stage checkpoint, in a SEPARATE tool step before the first investigative tool, finishThinking, or any other action. This applies to simple requests and apparent blockers too. Start the text with Opening |. Acknowledge what the user wants, give your initial take if there is a defensible one, label it provisional, and state your concrete plan or next move. If there is not enough evidence for a view, say what you need to check. Make the handoff useful as a short opening reply; do not claim any work is already done.",
        "The host accepts checkpoints of at most 2,400 characters each. After each search, recall, source read, or completed substantive work phase, your NEXT tool step MUST be offerReply with stage checkpoint, before any further tool, final handoff, or finishThinking. Start the text with Progress |. Pass what you checked, what you found with its source, any uncertainty, and what remains. Report empty, failed, and partial results too. Do not save these results for the final handoff.",
        "If multiple tools complete in parallel, send ONE combined checkpoint as the next tool step at that boundary carrying every material result or status from each call. Preserve successes, failures and partial results; never lose one because another finished or failed. When a checkpoint is rejected, do not retry or claim delivery: carry all remaining unhanded evidence, errors and status into the final handoff.",
        "Handoffs are internal event notes, not drafts. Short labels, fragments, or bullets are fine. Opening carries the task, a provisional view or explicit unknown, and the plan. Progress carries the result or error, its source, what is uncertain, and the next step. Never invent facts, expose private reasoning or payloads, send tool logs, or put HTML in a checkpoint.",
        "Illustrative calls using the current payload (their facts are examples only): offerReply({stage: \"checkpoint\", text: \"Opening | Ask: pilot date. Initial view: unknown without the latest schedule. Plan: check brief, then confirm against meeting notes.\"}); offerReply({stage: \"checkpoint\", text: \"Progress | Found: Tuesday in research/launch/index.md (read launch-read:1). Uncertain: meeting agreement. Next: check original meeting turn.\"}); offerReply({stage: \"checkpoint\", text: \"Progress | Brief: Tuesday (read launch-read:1). Meeting recall: source unavailable. Next: state the source and caveat.\"}).",
        "A simple direct turn still sends the opening checkpoint first, then may proceed directly to the final offerReply before finishThinking if no investigation is needed.",
        "For a genuine user-input blocker after the required opening checkpoint — missing information, a missing file, a decision only the user can make, or missing permission — use finishThinking alone with needsUser for the terminal handoff. The host wakes dialogue with needs_user; do not add a final offerReply for the same blocker. An empty or failed search still requires a progress checkpoint and is not by itself a user blocker.",
        "Otherwise, when work is complete, call offerReply exactly once with stage final. Use compact event notes, not a drafted answer: give the complete verified result, every material still-unhanded result or error, evidence or source, and limitations. State what remains (or none), and include every complete native HTML artifact there rather than emitting standalone artifact prose. Wait for the final offer to succeed, then call finishThinking in a SEPARATE later tool step with compact structured findings for evidence and attribution. Never bundle or run final offerReply and finishThinking in parallel. finishThinking remains the terminal work report. An accepted explicit final suppresses the host fallback final. Illustrative final call: offerReply({stage: \"final\", text: \"Final | Result: Tuesday. Sources: launch brief (read launch-read:1), meeting turn (read meeting-read:1). Caveat: start time not specified. Remaining: none.\"}).",
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
