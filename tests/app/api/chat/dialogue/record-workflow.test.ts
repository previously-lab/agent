import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DialogueRecordRequest } from "@/lib/dialogue/transport";

const h = vi.hoisted(() => ({ project: vi.fn(), ring: vi.fn(), getRun: vi.fn() }));
vi.mock("@/lib/episodic/dialogue-records", () => ({ projectDialogueRecords: h.project }));
vi.mock("@/app/api/chat/steps", () => ({ ringReflection: h.ring }));
vi.mock("workflow/api", () => ({ getRun: h.getRun }));

import { dialogueRecordWorkflow } from "@/app/api/chat/dialogue-record-workflow";

const request: DialogueRecordRequest = {
  source: {
    inputId: "input", clientMessageId: "message", userSeq: 1, eventSeq: 1,
    acceptedAt: "2026-11-07T00:00:00.000Z", text: "question",
  },
  sourceTurnId: "input",
  environment: {
    useGithub: false, useDemo: false, owner: "local", repo: "local", timezone: "UTC",
    sliceId: "2026-11-07-0000",
    slicing: { idleGapMinutes: 30, maxSliceMinutes: 60, maxTurnsPerSlice: 40 },
  },
  utterance: {
    utteranceId: "work:call", publicSeq: 1, committedAt: "2026-11-07T00:00:01.000Z",
    inputIds: ["input"], sourceResults: [],
    blocks: [{ kind: "markdown", blockId: "reply", text: "answer" }],
  },
};

describe("dialogue record workflow", () => {
  it("persists actual public output and independently rings its record ranges", async () => {
    h.project.mockResolvedValue({
      sliceId: "2026-11-07-0000", inputIds: ["input"], utteranceIds: ["work:call"],
      inputLandings: [], reflection: [{ sliceId: "2026-11-07-0000", turnIds: ["input"] }], commitSha: null,
    });
    await dialogueRecordWorkflow(request);
    expect(h.project).toHaveBeenCalledWith(expect.objectContaining({
      utterance: request.utterance,
      inputs: [expect.objectContaining({ input: request.source, turnId: "input", reflectUserOnly: true })],
    }));
    expect(h.ring).toHaveBeenCalledWith("2026-11-07-0000", { sliceId: "2026-11-07-0000", turnIds: ["input"] });
  });

  it("recovers published native bytes from the known child only in the background flow", async () => {
    const body = "<!doctype html><p>archived</p>";
    const artifact = {
      artifactId: "b".repeat(64), sourceOwnerId: "wrun_child", revision: 1 as const,
      sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
      kind: "native_html" as const, mediaType: "text/html",
    };
    const typed = { blockId: "widget", artifact, body };
    h.getRun.mockReturnValue({ getReadable: () => ({
      getTailIndex: async () => 0,
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ value: { type: "data-dialogue-artifact", data: typed } })
          .mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn(),
      }),
    }) });
    h.project.mockResolvedValue(null);
    const utterance = { ...request.utterance!, blocks: [{ kind: "artifact_ref" as const, blockId: "widget", artifact }] };
    await dialogueRecordWorkflow({ ...request, utterance });
    expect(h.getRun).toHaveBeenCalledWith("wrun_child");
    expect(h.project).toHaveBeenCalledWith(expect.objectContaining({ utterance, typedArtifacts: [typed] }));
  });
});
