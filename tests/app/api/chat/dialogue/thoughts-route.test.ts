import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("workflow/api", () => ({ getRun: h.getRun }));

import { GET } from "@/app/api/chat/[runId]/thoughts/route";

it("replays safe text and real tool status while hiding the internal offer trigger", async () => {
  const chunks = [
    { type: "reasoning-delta", id: "thought", delta: "Thinking about this prompt" },
    { type: "text-delta", id: "text", delta: "safe result" },
    { type: "tool-input-available", toolCallId: "time", toolName: "currentTime" },
    { type: "tool-output-available", toolCallId: "time", output: "private payload" },
    { type: "tool-input-available", toolCallId: "offer", toolName: "offerReply" },
    { type: "tool-output-available", toolCallId: "offer", output: { runId: "private" } },
  ];
  const readable = new ReadableStream<unknown>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  });
  h.getRun.mockReturnValue({
    status: Promise.resolve("completed"),
    getReadable: () => Object.assign(readable, { getTailIndex: async () => chunks.length - 1 }),
  });
  const runId = "wrun_01JTESTPARENT0000000000000";
  const response = await GET(new Request(`http://localhost/api/chat/${runId}/thoughts?workId=work-1`), {
    params: Promise.resolve({ runId }),
  });
  const text = await response.text();
  expect(text).toContain("safe result");
  expect(text).toContain('"type":"reasoning"');
  expect(text).toContain("Thinking about this prompt");
  expect(text).toContain("currentTime");
  expect(text).not.toContain("offerReply");
  expect(text).not.toContain("private payload");
  expect(text).toContain('"status":"completed"');
});
