/**
 * StepBoundaryLanguageModel — the wrapper that crosses the workflow→step
 * boundary for the chat agent (upstream vercel/workflow#2956: Workflow 5's
 * SWC plugin never registers SDK provider classes in the step bundle, so no
 * SDK model instance may cross). Verifies:
 *   - the serialization statics produce JSON-round-trippable plain data
 *     carrying the ModelConfig (the only payload that crosses)
 *   - the inner model is built LAZILY via createModel — exactly once, on
 *     first use (supportedUrls / doStream / doGenerate) — with calls
 *     forwarded to a REAL model (the bridge path needs no API keys, so the
 *     real createModel dispatch runs against a fixture bridge CLI, same
 *     pattern as bridge-model.test.ts)
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

// Spy on createModel while calling through to the real implementation — the
// wrapper must build the inner model lazily and exactly once.
vi.mock("@/lib/models/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/models/provider")>();
  return { ...actual, createModel: vi.fn(actual.createModel) };
});

import { createModel } from "@/lib/models/provider";
import { StepBoundaryLanguageModel } from "@/lib/models/step-boundary-model";
import type { ModelConfig } from "@/lib/models/registry";

const createModelSpy = vi.mocked(createModel);

const FIXTURES = fileURLToPath(
  new URL("../../app/api/agent/fixtures", import.meta.url),
);

/** Quote both segments — node may live in a path with spaces. */
function bridgeCmd(fixture: string): string {
  return `"${process.execPath}" "${join(FIXTURES, fixture)}"`;
}

const SAVED_CMD = process.env.PREVIOUSLY_BRIDGE_CMD;

/** Minimal bridge ModelConfig — createModel's bridge path needs no env keys. */
const CONFIG: ModelConfig = {
  id: "bridge/claude",
  name: "Claude (subscription bridge)",
  provider: "bridge",
  providerName: "Subscription Bridge",
  sdk: "bridge",
  envKey: "PREVIOUSLY_BRAIN",
  capabilities: { thinking: false, vision: false, maxTokens: 200_000 },
  defaultThinking: false,
  defaultEffort: "low",
};

const PROMPT: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

function serialize(model: StepBoundaryLanguageModel): { config: ModelConfig } {
  return (
    StepBoundaryLanguageModel as unknown as Record<
      symbol,
      (m: StepBoundaryLanguageModel) => { config: ModelConfig }
    >
  )[WORKFLOW_SERIALIZE](model);
}

function deserialize(data: {
  config: ModelConfig;
}): StepBoundaryLanguageModel {
  return (
    StepBoundaryLanguageModel as unknown as Record<
      symbol,
      (d: { config: ModelConfig }) => StepBoundaryLanguageModel
    >
  )[WORKFLOW_DESERIALIZE](data);
}

beforeEach(() => {
  createModelSpy.mockClear();
  process.env.PREVIOUSLY_BRIDGE_CMD = bridgeCmd("bridge-ok.mjs");
});

afterAll(() => {
  if (SAVED_CMD === undefined) delete process.env.PREVIOUSLY_BRIDGE_CMD;
  else process.env.PREVIOUSLY_BRIDGE_CMD = SAVED_CMD;
});

describe("StepBoundaryLanguageModel identity", () => {
  it("is a spec-v3 language model exposing the config's sdk/id", () => {
    const model = new StepBoundaryLanguageModel(CONFIG);
    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("bridge");
    expect(model.modelId).toBe("bridge/claude");
  });
});

describe("StepBoundaryLanguageModel workflow serialization", () => {
  it("serializes to JSON-round-trippable plain data carrying the config", () => {
    const model = new StepBoundaryLanguageModel(CONFIG);
    const payload = serialize(model);
    expect(payload).toEqual({ config: CONFIG });
    // The workflow serializer requires plain JSON — no SDK model instance may
    // be reachable from the payload, and no construction may happen yet.
    const roundTripped = JSON.parse(JSON.stringify(payload));
    expect(roundTripped).toEqual({ config: CONFIG });
    expect(createModelSpy).not.toHaveBeenCalled();
  });

  it("revives through WORKFLOW_DESERIALIZE with identity intact", () => {
    const model = new StepBoundaryLanguageModel(CONFIG);
    const revived = deserialize(JSON.parse(JSON.stringify(serialize(model))));
    expect(revived).toBeInstanceOf(StepBoundaryLanguageModel);
    expect(revived).not.toBe(model);
    expect(revived.provider).toBe("bridge");
    expect(revived.modelId).toBe("bridge/claude");
    expect(createModelSpy).not.toHaveBeenCalled();
  });
});

describe("StepBoundaryLanguageModel lazy inner construction", () => {
  it("does not construct the inner model at construction time", () => {
    new StepBoundaryLanguageModel(CONFIG);
    expect(createModelSpy).not.toHaveBeenCalled();
  });

  it("constructs via createModel exactly once across supportedUrls, doStream, and doGenerate", async () => {
    const model = new StepBoundaryLanguageModel(CONFIG);

    // First use (the supportedUrls getter) builds the inner model…
    expect(model.supportedUrls).toEqual({});
    expect(createModelSpy).toHaveBeenCalledTimes(1);
    expect(createModelSpy).toHaveBeenCalledWith(CONFIG);

    // …doStream forwards to that same inner instance (real bridge fixture —
    // the exact stdin contract bridge-model.test.ts pins)…
    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts: Array<{ type: string; delta?: string }> = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as { type: string; delta?: string });
    }
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts.find((p) => p.type === "text-delta")?.delta).toBe(
      "ok:hello|ctx:null",
    );

    // …and doGenerate reuses it — still exactly one construction.
    const result = await model.doGenerate({ prompt: PROMPT });
    expect(createModelSpy).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([{ type: "text", text: "ok:hello|ctx:null" }]);
  });

  it("a deserialized wrapper also builds its inner model lazily on first use", async () => {
    // The step-runtime revival path: plain JSON in, wrapper out, nothing
    // constructed until the model is actually called.
    const revived = deserialize(
      JSON.parse(JSON.stringify(serialize(new StepBoundaryLanguageModel(CONFIG)))),
    );
    expect(createModelSpy).not.toHaveBeenCalled();

    const result = await revived.doGenerate({ prompt: PROMPT });
    expect(createModelSpy).toHaveBeenCalledTimes(1);
    expect(createModelSpy).toHaveBeenCalledWith(CONFIG);
    expect(result.content).toEqual([{ type: "text", text: "ok:hello|ctx:null" }]);
  });
});
