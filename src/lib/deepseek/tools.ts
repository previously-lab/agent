import { z } from "zod";
import type { Tool, ToolSet, SerializedTool, StopCondition } from "./types";

export function tool<Input, Output, Context>(definition: Tool<Input, Output, Context> & Required<Pick<Tool<Input, Output, Context>, "execute">>): Tool<Input, Output, Context> & Required<Pick<Tool<Input, Output, Context>, "execute">>;
export function tool<Input, Output, Context>(definition: Tool<Input, Output, Context>): Tool<Input, Output, Context>;
export function tool<Input, Output, Context>(definition: Tool<Input, Output, Context>): Tool<Input, Output, Context> {
  return definition;
}
export function isStepCount(count: number): StopCondition {
  if (!Number.isInteger(count) || count < 1) throw new Error("Step count must be a positive integer");
  return Object.assign(({ steps }: Parameters<StopCondition>[0]) => steps.length >= count, { maxSteps: count });
}
export function serializeTools(tools: ToolSet | undefined): SerializedTool[] | undefined {
  if (!tools || !Object.keys(tools).length) return undefined;
  return Object.entries(tools).map(([name, definition]) => {
    const parameters = z.toJSONSchema(definition.inputSchema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: "function", function: { name, description: definition.description, parameters } };
  });
}
export class InvalidToolInputError extends Error {
  constructor(readonly toolName: string, message: string) {
    super(`${toolName}: ${message}`);
    this.name = "InvalidToolInputError";
  }
  static isInstance(error: unknown): boolean {
    return !!error && typeof error === "object" && "name" in error && error.name === "InvalidToolInputError";
  }
}
