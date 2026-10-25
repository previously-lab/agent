import { z } from "zod";
import { createTaskToolSchema, updateTaskToolSchema } from "@/lib/tasks/contracts";

const evidenceQuote = z.string().min(1).max(4000).optional().describe(
  "Exact excerpt from the CURRENT user's actual message identifying this commitment or correction. Required when that message exceeds 4000 characters; never quote generated HTML or your own proposals.",
);

export const fieldCreateTaskSchema = createTaskToolSchema.extend({ evidenceQuote });
export const fieldUpdateTaskSchema = updateTaskToolSchema.extend({ evidenceQuote });
export type FieldCreateTaskInput = z.infer<typeof fieldCreateTaskSchema>;
export type FieldUpdateTaskInput = z.infer<typeof fieldUpdateTaskSchema>;
