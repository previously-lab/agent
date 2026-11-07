import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DialogueParentController,
  parseDialogueAcceptedV2,
  parseDialogueParentEvent,
  type DialogueAcceptedV2,
} from "../dialogue-parent-stream";
import type { DialogueProjection } from "../dialogue-projection";

const acceptance: DialogueAcceptedV2 = {
  version: 2,
  parentRunId: "parent-1",
  sourceInputId: "input-1",
  workId: "work-1",
  offersUrl: "/api/chat/parent-1/offers",
  thoughtsUrl: "/api/chat/parent-1/thoughts",
};

function sse(events: Array<Record<string, unknown>>, finish = true) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      if (finish) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function publicReply(text: string) {
  return sse([
    { type: "start", messageId: "publication-1" },
    { type: "data-dialogue-source", id: "offer-1", data: { offerId: "offer-1", sourceInputId: "input-1" } },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish" },
  ]);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe("v2 parent and public child transport", () => {
  it("validates the agreed envelope and admitted offer identities", () => {
    expect(parseDialogueAcceptedV2(acceptance)).toEqual(acceptance);
    expect(() => parseDialogueAcceptedV2({ ...acceptance, version: 1 })).toThrow("Invalid dialogue acceptance");
    expect(parseDialogueParentEvent({ type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" })).toEqual({
      type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1",
    });
    expect(parseDialogueParentEvent({ type: "done", parentRunId: "parent-1" })).toEqual({ type: "done" });
    expect(() => parseDialogueParentEvent({ type: "offer", offerId: "offer-1", runId: "child-1" })).toThrow("Invalid");
  });


  it("uses the terminal typed publication and only its matching artifact bytes", async () => {
    const body = "<!doctype html><p>Safe widget</p>";
    const artifact = {
      artifactId: "artifact-1", sourceOwnerId: "parent-1", revision: 1 as const, kind: "native_html" as const,
      mediaType: "text/html", sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
    };
    const publication = {
      utteranceId: "offer-1", publicSeq: 1, committedAt: "2026-11-07T01:00:00.000Z", inputIds: ["input-1"], sourceResults: [],
      blocks: [{ kind: "markdown", blockId: "text", text: "Public answer" },
        { kind: "artifact_ref", blockId: "widget", artifact }],
    };
    const scope = new AbortController();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
        { type: "done", parentRunId: "parent-1" },
      ]);
      if (url.startsWith("/api/chat/child-1/stream")) return sse([
        { type: "start", messageId: "offer-1" },
        { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "Public answer" },
        { type: "data-dialogue-artifact", id: "artifact-1", data: { blockId: "widget", artifact, body } },
        { type: "data-dialogue-publication", id: "offer-1", data: publication },
        { type: "text-end", id: "text" }, { type: "finish" },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage: memoryStorage(),
      onProjection: next => { projection = next; }, onPublication: () => {} });
    controller.start();
    controller.accept(acceptance, { id: "client-1", role: "user", parts: [{ type: "text", text: "Question" }] });
    await vi.waitFor(() => expect(projection?.works.get("work-1")?.status).toBe("completed"));
    const entry = projection?.entries.find(candidate => candidate.id === "offer-1");
    expect(entry?.kind).toBe("utterance");
    if (entry?.kind !== "utterance") throw new Error("Missing typed publication");
    expect(entry.utterance.blocks).toEqual(publication.blocks);
    expect(entry.artifactBodies?.get("artifact-1")).toBe(body);
    expect(projection?.utterances.has("offer-1")).toBe(true);
    scope.abort();
  });

  it("reconnects parents, dedupes offers, reads public children once, and recovers known IDs locally", async () => {
    const storage = memoryStorage();
    const scope = new AbortController();
    let offerReads = 0;
    let childReads = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl || url.startsWith(`${acceptance.offersUrl}?startIndex=`)) {
        offerReads++;
        if (offerReads === 1) return sse([{ type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" }], false);
        if (offerReads === 2) return sse([
          { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
          { type: "done", parentRunId: "parent-1", status: "running", cursor: 7, retryAfterMs: 1 },
        ]);
        expect(url).toBe(`${acceptance.offersUrl}?startIndex=7`);
        return sse([
          { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
          { type: "done", parentRunId: "parent-1", status: "completed", cursor: 8 },
        ]);
      }
      if (url.startsWith("/api/chat/child-1/stream?startIndex=0")) {
        childReads++;
        return publicReply("Only public prose");
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const published = vi.fn();
    const controller = new DialogueParentController({
      persona: "fixture", signal: scope.signal, request, storage, retryDelayMs: 1,
      onProjection: next => { projection = next; }, onPublication: published,
    });
    controller.start();
    controller.accept(acceptance, { id: "client-1", role: "user", parts: [{ type: "text", text: "Question" }] });

    await vi.waitFor(() => {
      expect(projection?.works.get("work-1")?.status).toBe("completed");
      expect(projection?.entries.map(entry => entry.kind)).toEqual(["input", "message"]);
    });
    expect(offerReads).toBe(3);
    expect(childReads).toBe(1);
    expect(published).toHaveBeenCalledTimes(1);
    const message = projection?.entries[1]?.kind === "message" ? projection.entries[1].message : undefined;
    expect(message?.id).toBe("publication-1");
    expect(message?.parts).toEqual([{ type: "text", text: "Only public prose", state: "done" }]);
    const stored = JSON.stringify([...storage.values.values()]);
    expect(stored.match(/offer-1/g)).toHaveLength(1);
    expect(stored).toContain("parent-1");
    expect(stored).toContain("child-1");
    scope.abort();

    const recoveryScope = new AbortController();
    let replayedChildren = 0;
    const recoveryRequest = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/chat/child-1/stream?startIndex=0")) {
        replayedChildren++;
        return publicReply("Only public prose");
      }
      throw new Error(`Unexpected recovery request: ${url}`);
    }) as typeof fetch;
    let recovered: DialogueProjection | undefined;
    const recovery = new DialogueParentController({
      persona: "fixture", signal: recoveryScope.signal, request: recoveryRequest, storage, retryDelayMs: 1,
      onProjection: next => { recovered = next; }, onPublication: () => {},
    });
    recovery.start();
    await vi.waitFor(() => {
      expect(recovered?.entries.some(entry => entry.kind === "message" && entry.message.id === "publication-1")).toBe(true);
      expect(recovered?.works.get("work-1")?.status).toBe("completed");
    });
    expect(replayedChildren).toBe(1);
    expect(recoveryRequest).not.toHaveBeenCalledWith(acceptance.offersUrl, expect.anything());
    recoveryScope.abort();
  });

  it("stops an active reply after its parent completes and preserves its partial text", async () => {
    const scope = new AbortController();
    const encoder = new TextEncoder();
    let finishChild: (() => void) | undefined;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
        { type: "done", parentRunId: "parent-1", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/child-1/stream")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(stream) {
            for (const event of [
              { type: "start", messageId: "publication-1" },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Partial answer" },
            ]) stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            finishChild = () => {
              for (const event of [{ type: "text-end", id: "text-1" }, { type: "finish" }]) {
                stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
              stream.close();
            };
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url === "/api/chat/parent-1/cancel") return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage: memoryStorage(),
      onProjection: next => { projection = next; }, onPublication: () => {} });

    try {
      controller.start();
      controller.accept(acceptance, { id: "client-1", role: "user", parts: [{ type: "text", text: "Question" }] });
      await vi.waitFor(() => {
        const entry = projection?.entries.find(candidate => candidate.kind === "message");
        expect(projection?.works.get("work-1")?.status).toBe("running");
        expect(entry?.kind === "message" && entry.message.parts).toEqual([
          expect.objectContaining({ type: "text", text: "Partial answer" }),
        ]);
      });

      await controller.stop("work-1");

      expect(request).toHaveBeenCalledWith("/api/chat/parent-1/cancel", expect.objectContaining({ method: "POST" }));
      expect(projection?.works.get("work-1")?.status).toBe("cancelled");
      const entry = projection?.entries.find(candidate => candidate.kind === "message");
      expect(entry?.kind === "message" && entry.message.parts).toEqual([
        expect.objectContaining({ type: "text", text: "Partial answer" }),
      ]);
    } finally {
      finishChild?.();
      scope.abort();
    }
  });

  it("bounds parent transport reconnects without misreporting the server work as failed", async () => {
    const storage = memoryStorage();
    const scope = new AbortController();
    const request = vi.fn(async () => sse([], false)) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const connections: string[] = [];
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage, retryDelayMs: 1,
      onProjection: next => {
        projection = next;
        const connection = next.works.get("work-1")?.connection;
        if (connection && connections.at(-1) !== connection) connections.push(connection);
      }, onPublication: () => {} });
    try {
      controller.start();
      controller.accept(acceptance, { id: "client-1", role: "user", parts: [{ type: "text", text: "Question" }] });
      await vi.waitFor(() => expect(projection?.works.get("work-1")?.connection).toBe("disconnected"));
      expect(projection?.works.get("work-1")?.status).toBe("running");
      expect(connections).toContain("reconnecting");
      expect(request).toHaveBeenCalledTimes(4);

      controller.resume();
      expect(projection?.works.get("work-1")?.connection).toBe("connected");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
      expect(request).not.toHaveBeenCalledWith("/api/chat", expect.anything());
    } finally {
      scope.abort();
    }
  });

  it("keeps a terminal parent failure in the local recovery record", async () => {
    const storage = memoryStorage();
    const scope = new AbortController();
    const request = vi.fn(async () => sse([{ type: "done", status: "failed" }])) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage,
      onProjection: next => { projection = next; }, onPublication: () => {} });
    controller.start();
    controller.accept(acceptance);
    await vi.waitFor(() => expect(projection?.works.get("work-1")?.status).toBe("failed"));
    scope.abort();

    const recoveryScope = new AbortController();
    let recovered: DialogueProjection | undefined;
    const recovery = new DialogueParentController({ persona: "fixture", signal: recoveryScope.signal,
      request: vi.fn(async () => { throw new Error("Unexpected terminal parent read"); }) as typeof fetch, storage,
      onProjection: next => { recovered = next; }, onPublication: () => {} });
    recovery.start();
    expect(recovered?.works.get("work-1")?.status).toBe("failed");
    recoveryScope.abort();
  });

  it("keeps child transport failure separate from work state and resumes the same child", async () => {
    const storage = memoryStorage();
    const scope = new AbortController();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
        { type: "done", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/child-1/stream")) return sse([
        { type: "start", messageId: "publication-1" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Visible partial answer" },
      ], false);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage, retryDelayMs: 1,
      onProjection: next => { projection = next; }, onPublication: () => {} });
    controller.start();
    controller.accept(acceptance);
    await vi.waitFor(() => expect(projection?.works.get("work-1")?.connection).toBe("disconnected"));
    expect(projection?.works.get("work-1")?.status).toBe("running");
    const partial = projection?.entries.find(entry => entry.kind === "message");
    expect(partial?.kind === "message" && partial.isStreaming).toBe(false);
    expect(partial?.kind === "message" && partial.message.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible partial answer" }),
    ]);
    scope.abort();

    const recoveryScope = new AbortController();
    const recoveryRequest = vi.fn(async () => publicReply("Recovered")) as typeof fetch;
    let recovered: DialogueProjection | undefined;
    const recovery = new DialogueParentController({ persona: "fixture", signal: recoveryScope.signal, request: recoveryRequest, storage,
      onProjection: next => { recovered = next; }, onPublication: () => {} });
    recovery.start();
    await vi.waitFor(() => expect(recovered?.works.get("work-1")?.status).toBe("completed"));
    expect(recovered?.works.get("work-1")?.connection).toBe("connected");
    expect(recoveryRequest).toHaveBeenCalledTimes(1);
    recoveryScope.abort();
  });

  it.each(["error", "interrupted"])("does not complete a child whose terminal turn status is %s despite finish", async turnStatus => {
    const storage = memoryStorage();
    const scope = new AbortController();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
        { type: "done", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/child-1/stream")) return sse([
        { type: "start", messageId: "publication-1" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Partial answer" },
        { type: "data-turn-status", id: "turn-status", data: { status: turnStatus } },
        { type: "text-end", id: "text-1" },
        { type: "finish" },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage,
      onProjection: next => { projection = next; }, onPublication: () => {} });
    controller.start();
    controller.accept(acceptance);
    await vi.waitFor(() => expect(projection?.works.get("work-1")?.status).toBe("failed"));
    const entry = projection?.entries.find(candidate => candidate.kind === "message");
    expect(entry?.kind === "message" && entry.isStreaming).toBe(false);
    expect(entry?.kind === "message" && entry.message.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Partial answer" }),
    ]);
    scope.abort();

    const recoveryScope = new AbortController();
    const recoveryRequest = vi.fn(async () => sse([
      { type: "start", messageId: "publication-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Partial answer" },
      { type: "data-turn-status", id: "turn-status", data: { status: turnStatus } },
      { type: "text-end", id: "text-1" },
      { type: "finish" },
    ])) as typeof fetch;
    let recovered: DialogueProjection | undefined;
    const recovery = new DialogueParentController({ persona: "fixture", signal: recoveryScope.signal, request: recoveryRequest, storage,
      onProjection: next => { recovered = next; }, onPublication: () => {} });
    recovery.start();
    await vi.waitFor(() => {
      const restored = recovered?.entries.find(candidate => candidate.kind === "message");
      expect(restored?.kind === "message" && restored.message.parts).toEqual([
        expect.objectContaining({ type: "text", text: "Partial answer" }),
      ]);
    });
    expect(recovered?.works.get("work-1")?.status).toBe("failed");
    expect(recoveryRequest).toHaveBeenCalledTimes(1);
    recovery.resume();
    expect(recoveryRequest).toHaveBeenCalledTimes(1);
    recoveryScope.abort();
  });

  it("treats an explicit stream error as terminal but an unreadable HTTP response as disconnected", async () => {
    const scope = new AbortController();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "offer", offerId: "offer-1", runId: "child-1", sourceInputId: "input-1" },
        { type: "done", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/child-1/stream")) {
        return sse([
          { type: "start", messageId: "publication-1" },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Partial answer" },
          { type: "error", errorText: "Explicit terminal stream failure" },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    let projection: DialogueProjection | undefined;
    const controller = new DialogueParentController({ persona: "fixture", signal: scope.signal, request, storage: memoryStorage(),
      onProjection: next => { projection = next; }, onPublication: () => {} });
    controller.start();
    controller.accept(acceptance);
    await vi.waitFor(() => expect(projection?.works.get("work-1")?.status).toBe("failed"));
    expect(projection?.works.get("work-1")?.connection).toBe("connected");

    const second = { ...acceptance, parentRunId: "parent-2", sourceInputId: "input-2", workId: "work-2",
      offersUrl: "/api/chat/parent-2/offers", thoughtsUrl: "/api/chat/parent-2/thoughts" };
    const secondRequest = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === second.offersUrl) return sse([
        { type: "offer", offerId: "offer-2", runId: "child-2", sourceInputId: "input-2" },
        { type: "done", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/child-2/stream")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const secondScope = new AbortController();
    let secondProjection: DialogueProjection | undefined;
    const secondController = new DialogueParentController({ persona: "http-fixture", signal: secondScope.signal, request: secondRequest,
      storage: memoryStorage(), onProjection: next => { secondProjection = next; }, onPublication: () => {} });
    secondController.start();
    secondController.accept(second);
    await vi.waitFor(() => expect(secondProjection?.works.get("work-2")?.connection).toBe("disconnected"));
    expect(secondProjection?.works.get("work-2")?.status).toBe("running");
    scope.abort();
    secondScope.abort();
  });
});
