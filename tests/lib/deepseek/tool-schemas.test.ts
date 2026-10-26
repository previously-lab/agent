import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { reportTaskFollowupInputSchema } from "@/lib/chat/task-followups";
import { generateText } from "@/lib/deepseek/generate";
import { isStepCount, serializeTools, tool } from "@/lib/deepseek/tools";
import type { SerializedTool } from "@/lib/deepseek/types";
import { skillOperationSchema } from "@/lib/evolution/skill-policy";

// Match the actual HQ tool, including the host-only-operation refinement.
const manageSkillInputSchema = skillOperationSchema.refine(
  (op) => op.kind !== "offer_review" && op.kind !== "check_source",
  "host-only operation",
);
const schemas = {
  reportTaskFollowup: reportTaskFollowupInputSchema,
  manageSkill: manageSkillInputSchema,
};
const schemaEntries: Array<[string, z.ZodType]> = Object.entries(schemas);

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete result.$schema;
  return result;
}

function response(delta: unknown, finishReason: string): Response {
  return new Response(
    [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("DeepSeek tool parameter schemas", () => {
  it.each(schemaEntries)("declares an object root for the real %s tool without losing union constraints", (name, inputSchema) => {
    const original = jsonSchema(inputSchema);
    const serialized = serializeTools({ [name]: tool({ inputSchema }) })![0];
    expect(serialized.function.parameters).toEqual({ ...original, type: "object" });
    expect(serialized.function.parameters).not.toHaveProperty("$schema");
  });

  it("leaves ordinary objects and nested unions unchanged", () => {
    const inputSchema = z.object({
      query: z.string().min(1),
      target: z.union([z.string(), z.object({ id: z.number().int() }).strict()]),
    }).strict();
    const serialized = serializeTools({ lookup: tool({ inputSchema }) })![0];
    expect(serialized.function.parameters).toEqual(jsonSchema(inputSchema));
  });

  it("omits absent and empty tool sets", () => {
    expect(serializeTools(undefined)).toBeUndefined();
    expect(serializeTools({})).toBeUndefined();
  });

  const invalidRoots: Array<[string, z.ZodType]> = [
    ["primitive", z.string()],
    ["array", z.array(z.object({ ref: z.string() }))],
    ["mixed union", z.union([z.object({ ref: z.string() }), z.string()])],
    ["nullable object", z.object({ ref: z.string() }).nullable()],
  ];
  it.each(invalidRoots)("rejects a %s root before any HTTP request", async (_label, inputSchema) => {
    const fetcher = vi.fn(async () => response({ content: "unused" }, "stop"));
    await expect(generateText({ prompt: "fixture", tools: { invalid: tool({ inputSchema }) } }, {
      fetch: fetcher, apiKey: "fixture",
    })).rejects.toThrow(/object/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("real union schemas at the HTTP and execution boundaries", () => {
  const cases: Array<{ name: keyof typeof schemas; input: unknown; valid: boolean }> = [
    { name: "reportTaskFollowup", input: { ref: "tasks/schema-regression" }, valid: true },
    { name: "reportTaskFollowup", input: { resultId: "background-result-1" }, valid: true },
    { name: "manageSkill", input: { kind: "retire", id: "existing-skill", operationId: "fixture-retire", expectedRevision: 1 }, valid: true },
    { name: "reportTaskFollowup", input: { ref: "tasks/schema-regression", resultId: "background-result-1" }, valid: false },
    { name: "reportTaskFollowup", input: {}, valid: false },
    { name: "manageSkill", input: { kind: "offer_review", id: "existing-skill", operationId: "fixture-review", expectedRevision: 1 }, valid: false },
    { name: "manageSkill", input: { kind: "check_source", id: "existing-skill", operationId: "fixture-check", expectedRevision: 1, sourceRevision: "source-1" }, valid: false },
    { name: "manageSkill", input: { kind: "retire", id: "existing-skill", operationId: "fixture-extra", expectedRevision: 1, extra: true }, valid: false },
  ];

  it.each(cases)("sends object schemas and preserves validation for $name ($input)", async ({ name, input, valid }) => {
    const execute = vi.fn(async (value: unknown) => ({ accepted: value }));
    const requests: Array<{ tools: SerializedTool[]; messages: Array<{ role: string; content: unknown }> }> = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string) as typeof requests[number];
      requests.push(body);
      // This is the provider boundary that the previous tool-executor tests skipped.
      expect(body.tools.map((entry) => [entry.function.name, entry.function.parameters.type])).toEqual([
        ["reportTaskFollowup", "object"], ["manageSkill", "object"],
      ]);
      if (requests.length > 1) return response({ content: "finished" }, "stop");
      return response({
        tool_calls: [{ index: 0, id: "fixture-call", function: { name, arguments: JSON.stringify(input) } }],
      }, "tool_calls");
    }) as typeof fetch;

    const result = await generateText({
      prompt: "fixture", stopWhen: isStepCount(2), tools: {
        reportTaskFollowup: tool({ inputSchema: schemas.reportTaskFollowup, execute }),
        manageSkill: tool({ inputSchema: schemas.manageSkill, execute }),
      },
    }, { fetch: fetcher, apiKey: "fixture" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("finished");
    expect(execute).toHaveBeenCalledTimes(valid ? 1 : 0);
    if (valid) {
      expect(execute.mock.calls[0][0]).toEqual(input);
      expect(result.steps[0].toolCalls[0].invalid).toBeUndefined();
    } else {
      expect(result.steps[0].toolCalls[0]).toMatchObject({ toolName: name, invalid: true });
      expect(requests[1].messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("error"))).toBe(true);
    }
  });
});
