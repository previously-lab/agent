import { describe, it, expect, vi, beforeEach } from "vitest";
import { type UIMessage } from "@/lib/chat/protocol";

// start-turn.ts is a route module — stub its workflow boundary so importing it
// for the pure helpers below stays hermetic.
const workflow = vi.hoisted(() => ({ start: vi.fn(async () => ({})) }));
vi.mock("workflow/api", () => ({ start: workflow.start }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: vi.fn() }));

// Config + catalog + environment seams for the pinning tests.
const loader = vi.hoisted(() => ({ loadUserConfig: vi.fn() }));
vi.mock("@/lib/config/loader", () => ({ loadUserConfig: loader.loadUserConfig }));
vi.mock("@/lib/models/catalog", () => ({
  resolveAvailableModels: vi.fn(async () => []),
}));
vi.mock("@/lib/capabilities", () => ({
  getRepoConfig: () => ({ owner: "local", repo: "local" }),
}));
const dataSource = vi.hoisted(() => ({ resolveDataSource: vi.fn(() => "local") }));
vi.mock("@/lib/data-source/resolve", () => ({
  resolveDataSource: dataSource.resolveDataSource,
}));
const demoLock = vi.hoisted(() => ({
  demoModelLock: vi.fn(
    (): { model: string; thinking: boolean; effort: "low" | "medium" | "high" } | null =>
      null,
  ),
}));
vi.mock("@/lib/demo/model-lock", () => ({
  demoModelLock: demoLock.demoModelLock,
}));

import {
  startTurn,
  summarizeModelContent,
  extractImageAttachments,
  MAX_MACHINE_CONTEXT_CHARS,
} from "@/app/api/chat/start-turn";

describe("summarizeModelContent", () => {
  it("passes string content through unchanged", () => {
    expect(summarizeModelContent("hello")).toBe("hello");
  });

  it("keeps text parts as text", () => {
    expect(
      summarizeModelContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("replaces image file parts with [image] — never the base64 payload", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(100000)}`;
    const out = summarizeModelContent([
      { type: "text", text: "what is this?" },
      { type: "file", mediaType: "image/png", url: dataUrl },
    ]);
    expect(out).toBe("what is this?\n[image]");
    expect(out).not.toContain("base64");
  });

  it("replaces non-image file parts with [file]", () => {
    expect(
      summarizeModelContent([
        { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,xx" },
      ]),
    ).toBe("[file]");
  });

  it("collapses other parts to a [type] placeholder", () => {
    expect(
      summarizeModelContent([
        { type: "tool-call", toolName: "recall" },
        { type: "reasoning", text: "hmm" },
      ]),
    ).toBe("[tool-call]\n[reasoning]");
  });
});

describe("extractImageAttachments", () => {
  const msg = (parts: UIMessage["parts"], id: string): UIMessage =>
    ({ id, role: "user", parts }) as UIMessage;

  it("extracts image file parts and replaces them with viewImage placeholders", () => {
    const dataUrl = "data:image/png;base64,xx";
    const { messages, attachments } = extractImageAttachments(
      [
        msg(
          [
            { type: "text", text: "what is this?" },
            { type: "file", mediaType: "image/png", url: dataUrl },
          ] as UIMessage["parts"],
          "m1",
        ),
      ],
      "en",
    );
    expect(attachments).toEqual([dataUrl]);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    expect(messages[0].parts[0]).toEqual({ type: "text", text: "what is this?" });
    expect(messages[0].parts[1]).toEqual({
      type: "text",
      text: expect.stringContaining('source "attachment:0"'),
    });
  });

  it("drops non-image file parts", () => {
    const { messages, attachments } = extractImageAttachments(
      [
        msg(
          [
            { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,xx" },
          ] as UIMessage["parts"],
          "m1",
        ),
        msg([{ type: "text", text: "still here" }] as UIMessage["parts"], "m2"),
      ],
      "en",
    );
    expect(attachments).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("m2");
  });

  it("drops messages left with no parts at all", () => {
    const { messages, attachments } = extractImageAttachments(
      [
        msg(
          [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,xx" }] as UIMessage["parts"],
          "m1",
        ),
      ],
      "en",
    );
    expect(attachments).toEqual(["data:image/png;base64,xx"]);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining('source "attachment:0"'),
    });
  });

  it("uses Chinese placeholders when locale is zh", () => {
    const { messages } = extractImageAttachments(
      [
        msg(
          [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,xx" }] as UIMessage["parts"],
          "m1",
        ),
      ],
      "zh",
    );
    expect(messages[0].parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("调用 viewImage"),
    });
  });

  it("caps extracted attachments at 4 images", () => {
    const parts: UIMessage["parts"] = Array.from({ length: 6 }, (_, i) => ({
      type: "file",
      mediaType: "image/png",
      url: `data:image/png;base64,${i}`,
    })) as UIMessage["parts"];
    const { attachments, messages } = extractImageAttachments(
      [msg(parts, "m1")],
      "en",
    );
    expect(attachments).toHaveLength(4);
    expect(messages[0].parts).toHaveLength(4);
  });

  it("numbers multiple placeholders in order", () => {
    const { messages, attachments } = extractImageAttachments(
      [
        msg(
          [
            { type: "file", mediaType: "image/png", url: "data:image/png;base64,a" },
            { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,b" },
          ] as UIMessage["parts"],
          "m1",
        ),
      ],
      "en",
    );
    expect(attachments).toEqual([
      "data:image/png;base64,a",
      "data:image/jpeg;base64,b",
    ]);
    const texts = messages[0].parts.map((p) =>
      p.type === "text" ? p.text : "",
    );
    expect(texts[0]).toContain("attachment:0");
    expect(texts[1]).toContain("attachment:1");
  });
});

// ─── startTurn: server-side thinking/effort pinning ─────────────────────────
// Product rule: fast responses — thinking is always ON at LOW effort for the
// main model, regardless of the request body or the stored config. Deep
// thinking is thinkDeep's job. Only the demo lock overrides the pin.

describe("startTurn thinking/effort pinning", () => {
  const SAVED_ENV = { ...process.env };

  const messages: UIMessage[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage,
  ];

  /** The TurnInput handed to the workflow run. */
  function turnInput(): Record<string, unknown> {
    const call = workflow.start.mock.calls.at(-1);
    expect(call).toBeDefined();
    const args = call as unknown as [unknown, [Record<string, unknown>]];
    return args[1][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED_ENV };
    dataSource.resolveDataSource.mockReturnValue("local");
    demoLock.demoModelLock.mockReturnValue(null);
    // A stored config that DISAGREES with the pin — must be ignored.
    loader.loadUserConfig.mockResolvedValue({
      model: {
        provider: "deepseek-flash",
        thinking: false,
        reasoningEffort: "high",
      },
    });
  });

  it("pins thinking ON and the middle effort HIGH, ignoring body + config", async () => {
    await startTurn({
      messages,
      model: "deepseek-flash",
      thinking: false, // client tries to disable — ignored
      effort: "high", // client tries to crank — ignored
    });
    const input = turnInput();
    expect(input.model).toBe("deepseek-flash");
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("high");
  });

  it("pins the middle effort HIGH even when the stored config says high", async () => {
    await startTurn({ messages, model: "deepseek-v4-pro" });
    const input = turnInput();
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("high");
  });

  it("ignores retired bridge env and requested model", async () => {
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    await startTurn({ messages, model: "bridge/claude", thinking: true });
    const input = turnInput();
    expect(input.model).toBe("deepseek-flash");
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("high");
  });

  it("legacy demo overrides cannot change the fixed policy", async () => {
    demoLock.demoModelLock.mockReturnValue({
      model: "deepseek-flash",
      thinking: true,
      effort: "medium",
    });
    await startTurn({
      messages,
      model: "claude-opus-4-8", // client choice — ignored under the lock
      effort: "high",
    });
    const input = turnInput();
    expect(input.model).toBe("deepseek-flash");
    expect(input.thinking).toBe(true);
    expect(input.reasoningEffort).toBe("high");
  });
});

// ─── startTurn: image attachment extraction for non-vision models ──────────

describe("startTurn image attachment handling", () => {
  const SAVED_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED_ENV };
    dataSource.resolveDataSource.mockReturnValue("local");
    demoLock.demoModelLock.mockReturnValue(null);
    loader.loadUserConfig.mockResolvedValue({
      model: { provider: "deepseek-flash" },
    });
  });

  /** The TurnInput handed to the workflow run. */
  function turnInput(): Record<string, unknown> {
    const call = workflow.start.mock.calls.at(-1);
    expect(call).toBeDefined();
    const args = call as unknown as [unknown, [Record<string, unknown>]];
    return args[1][0];
  }

  it("legacy model id cannot disable native image support", async () => {
    const imageUrl = "data:image/png;base64,xx";
    const msgs: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "what is this?" },
          { type: "file", mediaType: "image/png", url: imageUrl },
        ],
      } as UIMessage,
    ];

    // deepseek-v4-pro is the curated TEXT-ONLY model (verified: it reports
    // "[Unsupported Image]"), so this is the path that must extract.
    await startTurn({ messages: msgs, model: "deepseek-v4-pro" });
    const input = turnInput();
    expect(input.imageAttachments).toEqual([]);
    expect(input.modelMessages).toEqual([{role:"user",content:[{type:"text",text:"what is this?"},{type:"image",image:imageUrl,mediaType:"image/png"}]}]);
    expect(Array.isArray(input.modelMessages)).toBe(true);
  });

  it("vision model keeps image file parts untouched and sends no attachments", async () => {
    const imageUrl = "data:image/png;base64,xx";
    const msgs: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "what is this?" },
          { type: "file", mediaType: "image/png", url: imageUrl },
        ],
      } as UIMessage,
    ];

    await startTurn({ messages: msgs, model: "deepseek-flash" });
    const input = turnInput();
    expect(input.imageAttachments).toEqual([]);
  });
});

// ─── startTurn: machine context block (v0.11 §13) ─────────────────────────
// The optional engine-built scene log rides TurnInput into the durable run —
// sanitized here, and OMITTED entirely when the client sends none, so a plain
// chat turn's input is byte-identical to before.

describe("startTurn machineContext carriage", () => {
  const messages: UIMessage[] = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage,
  ];

  /** The TurnInput handed to the workflow run. */
  function turnInput(): Record<string, unknown> {
    const call = workflow.start.mock.calls.at(-1);
    expect(call).toBeDefined();
    const args = call as unknown as [unknown, [Record<string, unknown>]];
    return args[1][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dataSource.resolveDataSource.mockReturnValue("local");
    demoLock.demoModelLock.mockReturnValue(null);
    loader.loadUserConfig.mockResolvedValue({
      model: { provider: "deepseek-flash" },
    });
  });

  it("carries a trimmed block into the durable run input", async () => {
    await startTurn({
      messages,
      machineContext: " [visit-log]\n池厅(09:41)\n[/visit-log] ",
    });
    expect(turnInput().machineContext).toBe(
      "[visit-log]\n池厅(09:41)\n[/visit-log]",
    );
  });

  it("OMITS the field when absent — the default turn input is unchanged", async () => {
    await startTurn({ messages });
    const input = turnInput();
    expect("machineContext" in input).toBe(false);
  });

  it("omits the field for a whitespace-only block", async () => {
    await startTurn({ messages, machineContext: "   " });
    expect("machineContext" in turnInput()).toBe(false);
  });

  it("caps an oversized block at MAX_MACHINE_CONTEXT_CHARS", async () => {
    await startTurn({ messages, machineContext: ` ${"x".repeat(5000)} ` });
    expect(turnInput().machineContext).toHaveLength(MAX_MACHINE_CONTEXT_CHARS);
  });
});


it("never starts capped history on an orphaned native tool result", async () => {
  loader.loadUserConfig.mockResolvedValue({model:{provider:"deepseek-flash"}});
  const oldMessages = [{role:"assistant",content:"earlier",deepseek:{role:"assistant",content:"earlier",reasoning_content:"why",tool_calls:Array.from({length:205},(_,i)=>({id:"t"+i,type:"function",function:{name:"read",arguments:"{}"}}))}},...Array.from({length:205},(_,i)=>({role:"tool",content:[{type:"tool-result",toolCallId:"t"+i,toolName:"read",output:{type:"text",value:"value"}}]}))];
  await startTurn({messages:[{id:"u0",role:"user",parts:[{type:"text",text:"old"}]},{id:"a0",role:"assistant",parts:[{type:"data-deepseek-step",data:{messages:oldMessages}}]},{id:"u1",role:"user",parts:[{type:"text",text:"new"}]}]});
  const call = workflow.start.mock.calls.at(-1) as unknown as [unknown,[{modelMessages:Array<{role:string;content:unknown}>}]];
  expect(call[1][0].modelMessages[0]).toEqual({role:"user",content:[{type:"text",text:"new"}]});
});
