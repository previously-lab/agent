import { runAgent } from "./runner";
import { callModelStep, writeAgentEventStep, closeAgentStreamStep } from "./steps";
import type { AgentOptions, AgentResult, ToolSet } from "./types";

/** Fixed DeepSeek orchestration; Workflow still owns each model/tool checkpoint. */
export class DeepSeekAgent<Tools extends ToolSet = ToolSet> {
  private invocation = 0;
  constructor(private readonly options: AgentOptions<Tools>) {}
  async stream(options: AgentOptions<Tools>): Promise<AgentResult<Tools>> {
    const merged = { ...this.options, ...options };
    const prefix = `deepseek:${this.invocation++}`;
    const result = await runAgent(merged,
      (request) => callModelStep(request, merged.writable),
      (event) => writeAgentEventStep(event, merged.writable), prefix, true);
    if (!merged.preventClose) await closeAgentStreamStep(merged.writable);
    return result;
  }
}
export type DeepSeekAgentOptions<Tools extends ToolSet = ToolSet> = AgentOptions<Tools>;
