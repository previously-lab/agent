import type { AgentOptions, AgentResult, ModelMessage } from "@/lib/deepseek/types";

interface WordingAgent {
  stream(options: AgentOptions): Promise<Pick<AgentResult, "text" | "finishReason">>;
}

/** A provider can finish a page at its own output boundary. Retain that page and
 * give the next call the exact prefix. Only a completed answer is published. */
export async function streamDialogueWording(agent: WordingAgent, options: AgentOptions & { prompt: string }): Promise<string> {
  let page = await agent.stream({ ...options, preventClose: true });
  let text = page.text;
  while (page.finishReason === "length" && page.text) {
    const messages: ModelMessage[] = [
      ...(options.messages ?? []),
      { role: "user", content: options.prompt },
      { role: "assistant", content: text },
    ];
    page = await agent.stream({ ...options, messages, preventClose: true,
      prompt: "Continue the same reply from the exact cutoff. Output only the remaining text, preserving its wording and formatting." });
    text += page.text;
  }
  if (page.finishReason !== "stop") throw new Error("Dialogue wording ended with " + page.finishReason);
  return text;
}
