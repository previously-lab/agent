/**
 * GET /api/evolution/hq/[runId]/stream — the attach contract. `workflow/api`'s
 * getRun is mocked; the filter and the SSE envelope are real. Pins: only
 * data-hq-activity chunks reach the wire (the sub-agent's tool-progress
 * telemetry stays in the run), the tail-index header, startIndex parsing,
 * and the clean 404 when the world no longer knows the run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getRun: h.getRun,
}));

import { GET } from "@/app/api/evolution/hq/[runId]/stream/route";

function fakeReadable(chunks: unknown[]) {
  const stream = new ReadableStream<unknown>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return Object.assign(stream, {
    getTailIndex: async () => chunks.length,
  });
}

function requestFor(runId: string, query = "") {
  return new Request(
    `http://localhost/api/evolution/hq/${encodeURIComponent(runId)}/stream${query}`,
  );
}

function paramsFor(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

const FRAMES = [
  {
    type: "data-hq-activity",
    id: "hq-a",
    data: { kind: "started", at: "2026-10-04T01:31:00.000Z" },
  },
  { type: "data-tool-progress", id: "t1", data: { line: "readSlice" } },
  {
    type: "data-hq-activity",
    id: "hq-b",
    data: { kind: "idle", at: "2026-10-04T01:33:00.000Z", note: "空转。" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/evolution/hq/[runId]/stream", () => {
  it("streams ONLY the data-hq-activity chunks as SSE, with the tail index header", async () => {
    h.getRun.mockReturnValue({ getReadable: () => fakeReadable(FRAMES) });
    const res = await GET(requestFor("run-1"), paramsFor("run-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-workflow-stream-tail-index")).toBe("3");

    const body = await res.text();
    expect(body).toContain(`data: ${JSON.stringify(FRAMES[0])}`);
    expect(body).toContain(`data: ${JSON.stringify(FRAMES[2])}`);
    expect(body).not.toContain("data-tool-progress");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("passes a valid startIndex through and degrades a junk one to 0", async () => {
    const getReadable = vi.fn(() => fakeReadable(FRAMES));
    h.getRun.mockReturnValue({ getReadable });

    await GET(requestFor("run-1", "?startIndex=4"), paramsFor("run-1"));
    expect(getReadable).toHaveBeenCalledWith({ startIndex: 4 });

    await GET(requestFor("run-1", "?startIndex=banana"), paramsFor("run-1"));
    expect(getReadable).toHaveBeenCalledWith({ startIndex: 0 });
  });

  it("an unknown run answers a clean 404, never a hang", async () => {
    h.getRun.mockImplementation(() => {
      throw new Error("run not found");
    });
    const res = await GET(requestFor("gone"), paramsFor("gone"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Run not available for attach",
    });
  });

  it("a run whose readable cannot be opened also answers 404", async () => {
    h.getRun.mockReturnValue({
      getReadable: () => {
        throw new Error("stream expired");
      },
    });
    const res = await GET(requestFor("old"), paramsFor("old"));
    expect(res.status).toBe(404);
  });
});
