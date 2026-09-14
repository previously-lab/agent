/**
 * Step-boundary language model — the ONLY LanguageModel instance that crosses
 * the workflow→step boundary: createChatAgent (src/app/api/agent/agent.ts)
 * hands it to WorkflowAgent, which internally passes it as an argument to
 * `doStreamStep`, where the workflow runtime serializes it.
 *
 * Why this wrapper exists: Workflow 5's SWC plugin auto-registers classes
 * carrying static WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE methods by inlining
 * a `__wf_cls_reg.set(...)` IIFE at compile time — but for node_modules
 * classes (every AI SDK provider model) that registration lands only in the
 * workflow (flow) bundle, not the step bundle, so step-side deserialization
 * of a provider model instance fails with 'Class ... not found' (upstream
 * vercel/workflow#2956, open). The runtime alias-registration workaround
 * (aliasSerializationClass) never took effect in the step execution context
 * either, and the SDKs' own deserializers rebuild models from JSON-safe
 * config only — dropping the url/headers/fetch closures, so the first request
 * died with "this.config.url is not a function".
 *
 * So no SDK model instance ever crosses the boundary. This first-party class
 * wraps a plain ModelConfig (already JSON-safe — it crosses inside TurnInput,
 * see src/app/api/chat/start-turn.ts), serializes to `{ config }`, and lazily
 * rebuilds the real model through createModel() on FIRST USE inside the
 * step — where the provider factories read their env keys from the step
 * runtime's own environment. Being our own class (like
 * BridgeChatLanguageModel), the plugin's compile-time registration applies to
 * it in EVERY bundle; the side-effect import in
 * src/app/api/agent/tool-executors.ts keeps the step-bundle copy evaluated.
 *
 * No static `classId` on purpose: Workflow 5's SWC plugin derives the id from
 * the file path and class name, registers the class under it, and installs it
 * as a non-configurable `classId`. Declaring our own made the serializer write
 * an id the compiler never registered.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { createModel } from "./provider";
import type { ModelConfig } from "./registry";

// Global-registry symbols shared with @workflow/serde (Symbol.for — safe to
// recreate here without importing the transitive package).
const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

export class StepBoundaryLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider: string;
  readonly modelId: string;

  /** The wrapped config — the only state that crosses the boundary. */
  private readonly config: ModelConfig;
  /** The lazily-built inner model; null until first use (never serialized). */
  private inner: LanguageModelV3 | null = null;

  constructor(config: ModelConfig) {
    this.config = config;
    this.provider = config.sdk;
    this.modelId = config.id;
  }

  // No `static classId` on purpose — see the file header.

  static [WORKFLOW_SERIALIZE](instance: StepBoundaryLanguageModel): {
    config: ModelConfig;
  } {
    return { config: instance.config };
  }

  static [WORKFLOW_DESERIALIZE](data: {
    config: ModelConfig;
  }): StepBoundaryLanguageModel {
    return new StepBoundaryLanguageModel(data.config);
  }

  /**
   * The real model, built on first use. Construction needs the provider
   * factories and their env keys; deferring it keeps the workflow (flow) side
   * free of provider construction entirely and lets the deserialized step-side
   * copy read the step runtime's own environment.
   */
  private getInner(): LanguageModelV3 {
    if (!this.inner) {
      // createModel's every branch returns a spec-v3 model; the declared
      // LanguageModel union is wider only on paper.
      this.inner = createModel(this.config) as LanguageModelV3;
    }
    return this.inner;
  }

  get supportedUrls(): LanguageModelV3["supportedUrls"] {
    return this.getInner().supportedUrls;
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    return this.getInner().doGenerate(options);
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    return this.getInner().doStream(options);
  }
}
