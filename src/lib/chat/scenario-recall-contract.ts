import { z } from "zod";

export const scenarioRecallRequestSchema = z.object({
  question: z.string().trim().min(1).max(4000).describe("The focused question to recover from earlier conversations, including relevant context and what remains uncertain."),
  refs: z.array(z.string().regex(/^records\/\d{4}-\d{2}-\d{2}-\d{4}$/)).max(4).optional()
    .describe("Up to four known original conversation refs. Omit to let recollection locate scenarios. Semantic documents are outside this tool."),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date lower bound, YYYY-MM-DD. Omit when uncertain."),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive UTC slice-date upper bound, YYYY-MM-DD. Omit when uncertain."),
}).strict();

export type ScenarioRecallRequest = z.infer<typeof scenarioRecallRequestSchema>;
