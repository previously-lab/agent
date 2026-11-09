import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  getReadable: vi.fn(),
  getDialogueStore: vi.fn(),
  work: vi.fn(),
  resultArtifact: vi.fn(),
  publicArtifact: vi.fn(),
  guard: vi.fn(),
  scope: vi.fn(),
}));

vi.mock("workflow/api", () => ({ getRun: mocks.getRun }));
vi.mock("@/lib/dialogue/runtime", () => ({
  getDialogueStore: mocks.getDialogueStore,
  guardDialogueRead: mocks.guard,
  resolveDialogueScope: mocks.scope,
  dialogueResponseError: () => Response.json({ error: "unavailable" }, { status: 503 }),
}));

import { GET as streamGET } from "@/app/api/chat/dialogue/work/[workId]/stream/route";
import { GET as artifactGET } from "@/app/api/chat/dialogue/work/[workId]/artifacts/[artifactId]/route";
import {
  applyDialogueWorkStreamEvent,
  emptyDialogueWorkStream,
  readDialogueWorkStream,
  type DialogueWorkStreamEvent,
} from "@/components/chat/dialogue-work-stream";

const artifact = {
  artifactId: "a".repeat(64), sourceOwnerId: "work-1:1", revision: 1,
  sha256: "b".repeat(64), byteSize: 20, kind: "native_html", mediaType: "text/html",
};

function work(overrides: Record<string, unknown> = {}) {
  return {
    workId: "work-1", inputId: "work-1", userSeq: 1, status: "running", runId: "run-1",
    acceptedAt: "2026-01-01T00:00:00.000Z", launch: {}, ...overrides,
  };
}

function attachRun(chunks: unknown[], status = "completed") {
  mocks.getReadable.mockImplementation(() => {
    const readable = new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    Object.assign(readable, { getTailIndex: async () => chunks.length - 1 });
    return readable;
  });
  mocks.getRun.mockReturnValue({ status: Promise.resolve(status), getReadable: mocks.getReadable });
}

function readStream(query = "persona=alice", workId = "work-1") {
  return streamGET(new Request(`http://localhost/api/chat/dialogue/work/${workId}/stream?${query}`), {
    params: Promise.resolve({ workId }),
  });
}

function readArtifact(workId = "work-1", persona = "alice") {
  return artifactGET(new Request(
    `http://localhost/api/chat/dialogue/work/${workId}/artifacts/${artifact.artifactId}?persona=${persona}`,
  ), { params: Promise.resolve({ workId, artifactId: artifact.artifactId }) });
}

function events(text: string) {
  return text.split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "));
    if (!line || line === "data: [DONE]") return [];
    return [JSON.parse(line.slice(6)) as Record<string, unknown>];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.scope.mockImplementation((persona) => `scope-${persona ?? "user"}`);
  mocks.work.mockResolvedValue(work());
  mocks.getDialogueStore.mockResolvedValue({
    work: mocks.work, resultArtifact: mocks.resultArtifact, artifact: mocks.publicArtifact,
  });
});

describe("work preview authorization and recovery", () => {
  it("applies the private-deployment guard before reading the work", async () => {
    mocks.guard.mockReturnValue(Response.json({ error: "Forbidden" }, { status: 403 }));
    expect((await readStream()).status).toBe(403);
    expect(mocks.work).not.toHaveBeenCalled();
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  it("scopes the work to the authenticated persona and waits for its run association", async () => {
    mocks.work.mockResolvedValue(work({ status: "queued", runId: undefined }));
    const response = await readStream();
    expect(mocks.work).toHaveBeenCalledWith("scope-alice", "work-1");
    expect(events(await response.text())).toEqual([
      expect.objectContaining({ type: "status", status: "waiting", workId: "work-1", cursor: 0 }),
    ]);
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  it("does not turn a caller-provided run id into access to another attempt", async () => {
    const response = await readStream("persona=alice&runId=other-run");
    expect(response.status).toBe(409);
    expect(mocks.getRun).not.toHaveBeenCalled();
  });

  it("replays through the filter and emits no duplicate prefix after a cursor", async () => {
    attachRun([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "hel" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "private reasoning" },
      { type: "text-delta", id: "text-1", delta: "lo" },
      { type: "tool-input-start", toolCallId: "call-1", toolName: "readFile" },
      { type: "tool-call", toolCallId: "call-1", toolName: "readFile", input: { path: "secret" } },
      { type: "tool-result", toolCallId: "call-1", toolName: "readFile", output: { token: "secret" } },
      { type: "finish" },
    ]);
    const response = await readStream("persona=alice&startIndex=3");
    const body = await response.text();
    expect(mocks.getReadable).toHaveBeenCalledWith({ namespace: "dialogue-thinking-v2", startIndex: 0 });
    expect(events(body)).toEqual([
      { type: "text", partId: "text-1", delta: "lo", workId: "work-1", runId: "run-1", cursor: 4 },
      { type: "tool", toolCallId: "call-1", toolName: "readFile", state: "running", workId: "work-1", runId: "run-1", cursor: 5 },
      { type: "tool", toolCallId: "call-1", toolName: "readFile", state: "completed", workId: "work-1", runId: "run-1", cursor: 7 },
      { type: "status", status: "completed", workId: "work-1", runId: "run-1", cursor: 8 },
    ]);
    expect(body).not.toContain("private reasoning");
    expect(body).not.toContain("secret");
    expect(events(body).filter((event) => event.delta === "hel")).toEqual([]);
  });

  it("can resume inside a native fence without exposing its HTML", async () => {
    attachRun([
      { type: "text-delta", id: "text-1", delta: "Before\n" },
      { type: "text-delta", id: "text-1", delta: "```html live\n<html>" },
      { type: "text-delta", id: "text-1", delta: "secret</html>\n" },
      { type: "text-delta", id: "text-1", delta: "```\nAfter" },
      { type: "finish" },
    ]);
    const body = await (await readStream("persona=alice&startIndex=2")).text();
    expect(events(body)).toEqual([
      { type: "text", partId: "text-1", delta: "After", workId: "work-1", runId: "run-1", cursor: 4 },
      { type: "status", status: "completed", workId: "work-1", runId: "run-1", cursor: 5 },
    ]);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("<html>");
  });

  it.each(["failed", "cancelled"] as const)("replays the safe prefix for a %s run", async (status) => {
    mocks.work.mockResolvedValue(work({ status }));
    attachRun([{ type: "text-delta", id: "text-1", delta: "partial" }], status);
    const response = await readStream();
    expect(events(await response.text())).toEqual([
      expect.objectContaining({ type: "text", delta: "partial" }),
      expect.objectContaining({ type: "status", status }),
    ]);
  });

  it("delivers durable tool events after the live reader stalls without losing the cursor", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const prefix = [
      ...Array.from({ length: 11 }, (_, index) => ({ type: "ignored", index })),
      { type: "text-delta", id: "text-1", delta: "Safe text" },
    ];
    const suffix = [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "currentTime" },
      { type: "tool-input-available", toolCallId: "call-1", toolName: "currentTime", input: { private: true } },
      { type: "tool-output-available", toolCallId: "call-1", output: { private: true } },
    ];
    let durableTail = prefix.length - 1;
    const source = (chunks: unknown[], close: boolean) => {
      const readable = new ReadableStream<unknown>({
        start(stream) {
          for (const chunk of chunks) stream.enqueue(chunk);
          if (close) stream.close();
        },
      });
      return Object.assign(readable, { getTailIndex: async () => durableTail });
    };
    mocks.getReadable.mockImplementation(({ startIndex }: { startIndex: number }) => {
      if (startIndex === 0) return source(prefix, false);
      if (startIndex === prefix.length) return source(suffix, true);
      throw new Error(`Unexpected resume cursor ${startIndex}`);
    });
    mocks.getRun.mockReturnValue({ status: Promise.resolve("running"), getReadable: mocks.getReadable });
    const received: DialogueWorkStreamEvent[] = [];
    try {
      const reading = readDialogueWorkStream({
        workId: "work-1", runId: "run-1", persona: "alice", signal: controller.signal,
        onEvent: event => received.push(event),
        request: (input, init) => streamGET(
          new Request(new URL(String(input), "http://localhost"), init),
          { params: Promise.resolve({ workId: "work-1" }) },
        ),
      });
      const observed = reading.then(() => undefined, () => undefined);
      for (let attempt = 0; attempt < 5 && !received.some(event => event.type === "text"); attempt++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(received).toContainEqual(expect.objectContaining({ type: "text", delta: "Safe text", cursor: 12 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.getReadable).toHaveBeenCalledTimes(1);
      durableTail = prefix.length + suffix.length - 1;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await observed;

      expect(mocks.getReadable).toHaveBeenNthCalledWith(2, { namespace: "dialogue-thinking-v2", startIndex: 12 });
      expect(received.filter(event => event.type === "text")).toHaveLength(1);
      expect(received).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool", toolName: "currentTime", state: "running", cursor: 13 }),
        expect.objectContaining({ type: "tool", toolName: "currentTime", state: "completed", cursor: 15 }),
      ]));
      const view = received.reduce(applyDialogueWorkStreamEvent, emptyDialogueWorkStream);
      expect(view.tools).toEqual([{ id: "call-1", name: "currentTime", status: "completed" }]);
      expect(view.cursor).toBe(15);
      expect(JSON.stringify(received)).not.toContain("private");
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });

  it("marks a truncated live attachment retryable without failing the run", async () => {
    attachRun([{ type: "text-delta", id: "text-1", delta: "partial" }], "running");
    const response = await readStream();
    expect(events(await response.text()).at(-1)).toEqual(
      expect.objectContaining({ type: "status", status: "live", retryAfterMs: 600, cursor: 1 }),
    );
  });
});

describe("completed work artifact preview", () => {
  it("reads only through the scoped result owner, never the public artifact gate", async () => {
    mocks.work.mockResolvedValue(work({ status: "completed", artifacts: [artifact] }));
    mocks.resultArtifact.mockResolvedValue({ artifact, body: "<html>private</html>" });
    const response = await readArtifact();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ artifact, body: "<html>private</html>" });
    expect(mocks.resultArtifact).toHaveBeenCalledWith("scope-alice", "work-1:1", artifact.artifactId);
    expect(mocks.publicArtifact).not.toHaveBeenCalled();
  });

  it("does not expose an unfinished or unrelated work artifact", async () => {
    expect((await readArtifact()).status).toBe(404);
    mocks.work.mockResolvedValue(work({ status: "completed", artifacts: [] }));
    expect((await readArtifact()).status).toBe(404);
    expect(mocks.resultArtifact).not.toHaveBeenCalled();
  });
});
