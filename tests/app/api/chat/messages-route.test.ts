/**
 * POST /api/chat/[runId]/messages — say-into-episode (v0.30 §3.5, batch B).
 *
 * The route's whole duty (D1): persist the user turn IMMEDIATELY (deduped by
 * the client-minted turnId), then tap E's inbox hook. Everything around it is
 * mocked at the module boundary — the workflow runtime (getRun/resumeHook),
 * the episodic write chain, the slice lock, the mode gates, and the origin
 * guard (exercised in its own tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const workflowApi = vi.hoisted(() => ({
  getRun: vi.fn(),
  resumeHook: vi.fn(async () => {}),
}));
vi.mock("workflow/api", () => workflowApi);

vi.mock("@/lib/security/origin-guard", () => ({ guardRequest: () => null }));

const episodic = vi.hoisted(() => ({
  tryLoadTodaySlice: vi.fn(),
  appendTurn: vi.fn((slice: { turns: unknown[] }, turn: unknown) => {
    slice.turns.push(turn);
  }),
  createBatch: vi.fn(() => ({ entries: new Map<string, string>() })),
  saveSliceSnapshot: vi.fn(async () => {}),
  flushBatch: vi.fn(async () => {}),
}));
vi.mock("@/lib/episodic", () => episodic);

// The lock is exercised by the concurrency tests; here it just runs the body.
vi.mock("@/lib/episodic/slice-mutex", () => ({
  withSliceLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

const dataSource = vi.hoisted(() => ({
  resolveDataSource: vi.fn(() => "github" as string),
}));
vi.mock("@/lib/data-source/resolve", () => dataSource);

const registry = vi.hoisted(() => ({
  isBridgeBrainActive: vi.fn(() => false),
}));
vi.mock("@/lib/models/registry", () => registry);

const clientConfig = vi.hoisted(() => ({
  readClientConfig: vi.fn(async () => ({ brain: "local" }) as unknown),
}));
vi.mock("@/lib/client-config", () => clientConfig);

const reflectionWake = vi.hoisted(() => ({
  deliverReflectionWake: vi.fn(async () => ({ ok: true as const, delivered: "resumed" as const, runId: "hq-1" })),
}));
vi.mock("@/app/api/evolution/reflection-wake", () => reflectionWake);

import { POST } from "@/app/api/chat/[runId]/messages/route";
import { HookNotFoundError } from "workflow/errors";
import type { TimeSlice } from "@/lib/episodic";

function makeSlice(turns: TimeSlice["turns"] = []): TimeSlice {
  return { slice_id: "2026-07-14-0900", turns } as TimeSlice;
}

function call(runId: string, body: unknown) {
  return POST(
    new Request(`http://localhost/api/chat/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

const LIVE_RUN = () => ({ status: Promise.resolve("running") });

beforeEach(() => {
  vi.clearAllMocks();
  workflowApi.getRun.mockReturnValue(LIVE_RUN());
  episodic.tryLoadTodaySlice.mockResolvedValue(makeSlice());
});

describe("POST /api/chat/[runId]/messages", () => {
  it("persists the user turn and taps E's inbox — {ok, turnId, deduped:false}", async () => {
    const res = await call("run_1", { text: " queued question ", turnId: "u2abc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, turnId: "u2abc", deduped: false });
    // persisted FIRST (红线), trimmed, on the active slice
    expect(episodic.appendTurn).toHaveBeenCalledTimes(1);
    const appended = episodic.appendTurn.mock.calls[0][1] as {
      role: string;
      content: string;
      turnId: string;
    };
    expect(appended).toMatchObject({ role: "user", content: "queued question", turnId: "u2abc" });
    expect(episodic.flushBatch).toHaveBeenCalledTimes(1);
    // the tap rides the derived token with the arrived kind (D2)
    expect(workflowApi.resumeHook).toHaveBeenCalledWith("episode:run_1", {
      kind: "arrived",
      turnId: "u2abc",
    });
  });

  it("a retried submit (same client-minted turnId) never writes twice — deduped:true, hook still tapped", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(
      makeSlice([{ timestamp: "t0", role: "user", content: "queued question", turnId: "u2abc" }]),
    );
    const res = await call("run_1", { text: "queued question", turnId: "u2abc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, turnId: "u2abc", deduped: true });
    expect(episodic.appendTurn).not.toHaveBeenCalled();
    expect(episodic.flushBatch).not.toHaveBeenCalled();
    expect(workflowApi.resumeHook).toHaveBeenCalledTimes(1);
  });

  it("400 on empty text / missing or malformed turnId", async () => {
    expect((await call("run_1", { text: "", turnId: "u2abc" })).status).toBe(400);
    expect((await call("run_1", { text: "hi" })).status).toBe(400);
    expect((await call("run_1", { text: "hi", turnId: "bad id!" })).status).toBe(400);
    expect((await call("run_1", { text: "hi", turnId: "abc" })).status).toBe(400); // too short
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("409 when the episode run is terminal — the client should start a fresh turn", async () => {
    workflowApi.getRun.mockReturnValue({ status: Promise.resolve("completed") });
    const res = await call("run_1", { text: "hi", turnId: "u2abc" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "completed" });
    expect(episodic.appendTurn).not.toHaveBeenCalled();
    expect(workflowApi.resumeHook).not.toHaveBeenCalled();
  });

  it("404 when the run id is unknown", async () => {
    workflowApi.getRun.mockImplementation(() => {
      throw new Error("run not found");
    });
    const res = await call("run_1", { text: "hi", turnId: "u2abc" });
    expect(res.status).toBe(404);
  });

  it("409 in demo mode and on the subscription bridge (D10 — no drainer exists)", async () => {
    dataSource.resolveDataSource.mockReturnValueOnce("demo");
    expect((await call("run_1", { text: "hi", turnId: "u2abc" })).status).toBe(409);

    registry.isBridgeBrainActive.mockReturnValueOnce(true);
    expect((await call("run_1", { text: "hi", turnId: "u2abc" })).status).toBe(409);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("409 when no active slice exists to record into", async () => {
    episodic.tryLoadTodaySlice.mockResolvedValue(null);
    const res = await call("run_1", { text: "hi", turnId: "u2abc" });
    expect(res.status).toBe(409);
    expect(episodic.appendTurn).not.toHaveBeenCalled();
  });

  it("HookNotFoundError on the tap: still 200 (the disk is the queue) and the reflection bell rings", async () => {
    workflowApi.resumeHook.mockRejectedValueOnce(new HookNotFoundError("episode:run_1"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await call("run_1", { text: "hi", turnId: "u2abc" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, turnId: "u2abc", deduped: false });
      // the message persisted regardless — the drain reconciles from disk
      expect(episodic.appendTurn).toHaveBeenCalledTimes(1);
      // the orphan gets the mechanical bell (the cancel route's precedent)
      expect(reflectionWake.deliverReflectionWake).toHaveBeenCalledWith({});
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a NON-HookNotFoundError tap failure propagates (the persist already landed)", async () => {
    workflowApi.resumeHook.mockRejectedValueOnce(new Error("workflow store down"));
    await expect(call("run_1", { text: "hi", turnId: "u2abc" })).rejects.toThrow(
      "workflow store down",
    );
    expect(episodic.appendTurn).toHaveBeenCalledTimes(1);
  });
});
