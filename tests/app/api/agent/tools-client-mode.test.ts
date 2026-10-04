/**
 * Client-mode tool gating: the subscription-bridge dispatch tool (and its
 * context entry) exist only when PREVIOUSLY_MODE=client.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  chatTools,
  getChatTools,
  buildChatToolsContext,
} from "@/app/api/agent/tools";
import type { ToolContext } from "@/app/api/agent/tool-executors";

const SAVED_MODE = process.env.PREVIOUSLY_MODE;

afterEach(() => {
  if (SAVED_MODE === undefined) delete process.env.PREVIOUSLY_MODE;
  else process.env.PREVIOUSLY_MODE = SAVED_MODE;
});

const ctx: ToolContext = {
  repo: "local",
  owner: "local",
  useGithub: false,
  useDemo: false,
  sliceId: "2026-08-19-1400",
  recentTurns: [],
};

describe("client-mode tool gating", () => {
  it("cloud mode: delegateTask is absent from the chat tool set", () => {
    delete process.env.PREVIOUSLY_MODE;
    const tools = getChatTools();
    expect(tools).not.toHaveProperty("delegateTask");
    expect(Object.keys(tools)).toEqual(Object.keys(chatTools));
    expect(buildChatToolsContext(ctx)).not.toHaveProperty("delegateTask");
  });

  it("client mode: delegateTask is registered with a context entry", () => {
    process.env.PREVIOUSLY_MODE = "client";
    const tools = getChatTools();
    expect(tools).toHaveProperty("delegateTask");
    for (const name of Object.keys(chatTools)) {
      expect(tools).toHaveProperty(name);
    }
    const contexts = buildChatToolsContext(ctx);
    expect(contexts.delegateTask).toBe(ctx);
  });
});

describe("chat tool surface", () => {
  it("exposes describeRoom in chatTools and gives it a context entry", () => {
    expect(chatTools).toHaveProperty("describeRoom");
    expect(buildChatToolsContext(ctx).describeRoom).toBe(ctx);
  });

  it("describeRoom takes an optional sliceId plus the optional runtime door inputs", () => {
    const schema = chatTools.describeRoom.inputSchema as unknown as {
      shape: Record<string, { isOptional(): boolean }>;
    };
    expect(schema.shape).toHaveProperty("sliceId");
    expect(schema.shape).toHaveProperty("strandDoors");
    expect(schema.shape).toHaveProperty("corridorSide");
    // No required parameters: "this room" is the default (ctx.sliceId).
    expect(schema.shape.sliceId.isOptional()).toBe(true);
    expect(schema.shape.strandDoors.isOptional()).toBe(true);
    expect(schema.shape.corridorSide.isOptional()).toBe(true);
  });

  it("exposes webFetch in chatTools and gives it a context entry", () => {
    expect(chatTools).toHaveProperty("webFetch");
    expect(buildChatToolsContext(ctx).webFetch).toBe(ctx);
  });

  it("exposes viewImage in chatTools and gives it a context entry", () => {
    expect(chatTools).toHaveProperty("viewImage");
    expect(buildChatToolsContext(ctx).viewImage).toBe(ctx);
  });

  it("viewImage accepts source and optional question", async () => {
    const { chatTools } = await import("@/app/api/agent/tools");
    const schema = chatTools.viewImage.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(schema.shape).toHaveProperty("source");
    expect(schema.shape).toHaveProperty("question");
  });

  it("webSearch accepts the optional mode input", async () => {
    const { chatTools } = await import("@/app/api/agent/tools");
    const schema = chatTools.webSearch.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(schema.shape).toHaveProperty("mode");
  });

  it("exposes the case-tree readers with context entries (v0.19 §A.2.1)", () => {
    expect(chatTools).toHaveProperty("listTree");
    expect(chatTools).toHaveProperty("readDoc");
    const contexts = buildChatToolsContext(ctx);
    expect(contexts.listTree).toBe(ctx);
    expect(contexts.readDoc).toBe(ctx);
  });

  it("exposes noteForSediment (the sediment mailbox writer) with a context entry", () => {
    expect(chatTools).toHaveProperty("noteForSediment");
    expect(buildChatToolsContext(ctx).noteForSediment).toBe(ctx);
    const schema = chatTools.noteForSediment.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(schema.shape).toHaveProperty("kind");
    expect(schema.shape).toHaveProperty("title");
    expect(schema.shape).toHaveProperty("dateAnchor");
  });

  it("exposes startLongTask (the conversation's sub-stream dispatch, v0.21 §2) with a context entry", () => {
    expect(chatTools).toHaveProperty("startLongTask");
    expect(buildChatToolsContext(ctx).startLongTask).toBe(ctx);
    const schema = chatTools.startLongTask.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(schema.shape).toHaveProperty("task");
    expect(schema.shape).toHaveProperty("note");
  });

  it("readDoc input: the two-segment ref (分类/case名[/篇名])", async () => {
    const { chatTools } = await import("@/app/api/agent/tools");
    const schema = chatTools.readDoc.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(schema.shape).toHaveProperty("ref");
    expect(schema.shape).not.toHaveProperty("fileName");
  });

  it("listTree takes no input", async () => {
    const { chatTools } = await import("@/app/api/agent/tools");
    const schema = chatTools.listTree.inputSchema as unknown as {
      shape: Record<string, unknown>;
    };
    expect(Object.keys(schema.shape)).toHaveLength(0);
  });

  it("the retired read tools are gone from the chat surface (v0.19 §A.2.1)", () => {
    for (const name of [
      "listDocs",
      "listSlices",
      "readTimeline",
      "readTimelineWindow",
      "listStrands",
      "readStrand",
      "readSliceSummary",
    ] as const) {
      expect(chatTools).not.toHaveProperty(name);
    }
    // The surviving memory surface:
    for (const name of ["readSlice", "readAgentTimeline", "readPreviously"] as const) {
      expect(chatTools).toHaveProperty(name);
      expect(buildChatToolsContext(ctx)[name]).toBe(ctx);
    }
  });
});

describe("toolContextSchema — step-boundary round-trip", () => {
  it("keeps timezone / startedAtIso / locale / imageAttachments through the schema re-parse (zod strips undeclared keys)", async () => {
    const { toolContextSchema } = await import("@/app/api/agent/tools");
    const full: ToolContext = {
      ...ctx,
      timezone: "Asia/Shanghai",
      startedAtIso: "2026-08-28T07:39:01.339Z",
      locale: "zh",
      imageAttachments: ["data:image/png;base64,xx"],
    };
    const parsed = toolContextSchema.parse(full);
    expect(parsed.timezone).toBe("Asia/Shanghai");
    expect(parsed.startedAtIso).toBe("2026-08-28T07:39:01.339Z");
    expect(parsed.locale).toBe("zh");
    expect(parsed.imageAttachments).toEqual(["data:image/png;base64,xx"]);
  });
});
