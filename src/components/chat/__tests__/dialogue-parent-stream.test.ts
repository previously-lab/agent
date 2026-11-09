import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@/lib/chat/protocol";
import {
  DialogueParentController,
  parseDialogueAcceptedV2,
  parseDialogueParentEvent,
  parseSubmittedUserMessage,
  type DialogueAcceptedV2,
} from "../dialogue-parent-stream";
import { appendDialogueTurn, dialogueMetadata, dialogueStreamRows } from "../dialogue-stream-rows";
import { findDialogueThoughtRuns } from "@/lib/chat/dialogue-run-recovery";

vi.mock("@/lib/chat/dialogue-run-recovery", () => ({ findDialogueThoughtRuns: vi.fn(async () => []) }));

const acceptance: DialogueAcceptedV2 = {
  version: 2,
  parentRunId: "thought-A",
  sourceInputId: "input-A",
  workId: "work-A",
  offersUrl: "/api/chat/thought-A/offers",
  thoughtsUrl: "/api/chat/thought-A/thoughts",
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

function publicReply(runId: string, publicationId: string, text: string, extra: Record<string, unknown>[] = []) {
  const response = sse([
    { type: "start", messageId: publicationId },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    ...extra,
    { type: "text-end", id: "text-1" },
    { type: "finish" },
  ]);
  response.headers.set("x-workflow-run-id", runId);
  return response;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(request: typeof fetch, storage = memoryStorage(), initial: UIMessage[] = []) {
  const scope = new AbortController();
  let messages = initial;
  const published = vi.fn();
  const controller = new DialogueParentController({
    persona: "fixture",
    signal: scope.signal,
    request,
    storage,
    retryDelayMs: 1,
    getMessages: () => messages,
    setMessages: update => { messages = update(messages); },
    onPublication: published,
  });
  return {
    controller,
    scope,
    storage,
    published,
    get messages() { return messages; },
  };
}

function acceptedSeat(id = "A") {
  return appendDialogueTurn([], {
    id, role: "user", parts: [{ type: "text", text: `Question ${id}` }],
  }, `assistant-${id}`, "2026-11-07T00:00:00.000Z");
}

describe("dialogue v2 thought/reply history", () => {
  it("validates envelopes and finds the submitted user before its fixed assistant", () => {
    expect(parseDialogueAcceptedV2(acceptance)).toEqual(acceptance);
    expect(() => parseDialogueAcceptedV2({ ...acceptance, version: 1 })).toThrow("Invalid dialogue acceptance");
    expect(parseDialogueParentEvent({ type: "done", status: "completed" })).toEqual({ type: "done", status: "completed" });
    const messages = acceptedSeat();
    expect(parseSubmittedUserMessage({ messages })?.id).toBe("A");
    expect(parseSubmittedUserMessage({ regenerate: true, dialogueInputId: "A", messages })?.id).toBe("A");
  });

  it("restores a completed thought from the server registry when local recovery is missing", async () => {
    vi.mocked(findDialogueThoughtRuns).mockResolvedValueOnce([{
      runId: "thought-remote", workId: "work-remote", sourceInputId: "input-remote", status: "completed",
      input: {
        inputId: "input-remote", clientMessageId: "remote-user", userSeq: 1, eventSeq: 1,
        acceptedAt: "2026-11-07T00:00:00.000Z", text: "Recovered question",
      },
    }]);
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/chat/dialogue/reply") return publicReply("dialogue-remote", "publication-remote", "Recovered answer");
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as typeof fetch;
    const chat = harness(request);
    chat.controller.start();
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({
      workStatus: "completed", thoughtRunId: "thought-remote", dialogueRunId: "dialogue-remote",
    }));
    expect(chat.messages.map(message => message.id)).toEqual(["remote-user", "recovered-work-remote"]);
    expect(chat.messages.at(-1)?.parts).toEqual([expect.objectContaining({ type: "text", text: "Recovered answer" })]);
  });

  it("posts the current complete messages only after thought completion and updates the same assistant", async () => {
    const old: UIMessage = { id: "old", role: "user", parts: [{ type: "text", text: "Earlier" }] };
    const replyBody = vi.fn();
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url === "/api/chat/dialogue/reply") {
        replyBody(JSON.parse(String(init?.body)));
        return publicReply("dialogue-A", "publication-A", "Public answer");
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), [old, ...acceptedSeat()]);
    chat.controller.accept(acceptance, "assistant-A", chat.messages[1]);
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({
      workStatus: "completed", thoughtRunId: "thought-A", dialogueRunId: "dialogue-A", publicationId: "publication-A",
    }));
    expect(replyBody).toHaveBeenCalledOnce();
    expect(replyBody.mock.calls[0][0]).toMatchObject({ thoughtRunId: "thought-A", workId: "work-A" });
    expect(replyBody.mock.calls[0][0].messages.map((message: UIMessage) => message.id)).toEqual(["old", "A", "assistant-A"]);
    expect(chat.messages.map(message => message.id)).toEqual(["old", "A", "assistant-A"]);
    expect(chat.messages.at(-1)?.parts).toEqual([expect.objectContaining({ type: "text", text: "Public answer" })]);
    expect(chat.published).toHaveBeenCalledTimes(1);
    chat.scope.abort();
  });

  it("completes B before A without moving seats or aborting A", async () => {
    const a = deferred<Response>();
    const requestSignals = new Map<string, AbortSignal | null | undefined>();
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url === "/api/chat/thought-B/offers") return sse([{ type: "done", status: "completed" }]);
      if (url === "/api/chat/dialogue/reply") {
        const body = JSON.parse(String(init?.body)) as { workId: string };
        requestSignals.set(body.workId, init?.signal);
        if (body.workId === "work-A") return a.promise;
        return publicReply("dialogue-B", "publication-B", "Answer B");
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const initial = [...acceptedSeat("A"), ...acceptedSeat("B")];
    const chat = harness(request, memoryStorage(), initial);
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    chat.controller.accept({ ...acceptance, parentRunId: "thought-B", sourceInputId: "input-B", workId: "work-B",
      offersUrl: "/api/chat/thought-B/offers", thoughtsUrl: "/api/chat/thought-B/thoughts" }, "assistant-B", chat.messages[2]);
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages[3]!)).toMatchObject({ workStatus: "completed" }));
    expect(requestSignals.get("work-A")?.aborted).toBe(false);
    expect(dialogueMetadata(chat.messages[1]!)).toMatchObject({ workStatus: "running", thoughtRunId: "thought-A" });
    a.resolve(publicReply("dialogue-A", "publication-A", "Answer A"));
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages[1]!)).toMatchObject({ workStatus: "completed" }));
    expect(chat.messages.map(message => message.id)).toEqual(["A", "assistant-A", "B", "assistant-B"]);
    expect(chat.messages[1]?.parts).toEqual([expect.objectContaining({ text: "Answer A" })]);
    expect(chat.messages[3]?.parts).toEqual([expect.objectContaining({ text: "Answer B" })]);
    chat.scope.abort();
  });

  it("dedupes parent completion and manual resume so reply is started once", async () => {
    let parentReads = 0;
    let replies = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl || url.startsWith(`${acceptance.offersUrl}?`)) {
        parentReads++;
        return parentReads === 1
          ? sse([{ type: "done", status: "running", cursor: 3, retryAfterMs: 1 }])
          : sse([{ type: "done", status: "completed", cursor: 4 }]);
      }
      if (url === "/api/chat/dialogue/reply") {
        replies++;
        return publicReply("dialogue-A", "publication-A", "Once");
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({ workStatus: "completed" }));
    chat.controller.resume();
    expect(replies).toBe(1);
    chat.scope.abort();
  });

  it("stops both durable phases of one work", async () => {
    const cancelled: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url === "/api/chat/dialogue/reply") {
        const response = new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: 200, headers: { "Content-Type": "text/event-stream", "x-workflow-run-id": "dialogue-A" },
        });
        return response;
      }
      if (url.endsWith("/cancel")) {
        cancelled.push(url);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!).dialogueRunId).toBe("dialogue-A"));
    await chat.controller.stop("work-A");
    expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({ workStatus: "cancelled" });
    expect(cancelled).toEqual(["/api/chat/thought-A/cancel", "/api/chat/dialogue-A/cancel"]);
    chat.scope.abort();
  });

  it("restores an in-flight record and replays its public run without another reply POST", async () => {
    const storage = memoryStorage();
    const firstRequest = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url === "/api/chat/dialogue/reply") return publicReply("dialogue-A", "publication-A", "Recovered answer");
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const first = harness(firstRequest, storage, acceptedSeat());
    first.controller.accept(acceptance, "assistant-A", first.messages[0]);
    await vi.waitFor(() => expect(dialogueMetadata(first.messages.at(-1)!)).toMatchObject({ workStatus: "completed" }));
    first.scope.abort();

    const recoveryRequest = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/dialogue-A/stream?startIndex=0") return publicReply("dialogue-A", "publication-A", "Recovered answer");
      throw new Error(`Unexpected recovery request: ${url}`);
    }) as typeof fetch;
    const recovered = harness(recoveryRequest, storage);
    recovered.controller.start();
    await vi.waitFor(() => expect(recovered.messages.at(-1)?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Recovered answer" }),
    ]));
    expect(recovered.messages.map(message => message.id)).toEqual(["A", "assistant-A"]);
    expect(recoveryRequest).toHaveBeenCalledTimes(1);
    expect(recoveryRequest).not.toHaveBeenCalledWith("/api/chat/dialogue/reply", expect.anything());
    recovered.scope.abort();

    const saved = harness(vi.fn(), storage);
    saved.controller.start(undefined, new Set(["publication-A"]));
    expect(saved.messages).toEqual([]);
    saved.scope.abort();
  });

  it("keeps reconnect state recoverable without starting a second work", async () => {
    let parentReads = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl || url.startsWith(`${acceptance.offersUrl}?`)) {
        parentReads++;
        return parentReads <= 4 ? sse([], false) : sse([{ type: "done", status: "completed" }]);
      }
      if (url === "/api/chat/dialogue/reply") return publicReply("dialogue-A", "publication-A", "After reconnect");
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!).workConnection).toBe("disconnected"));
    expect(parentReads).toBe(4);
    chat.controller.resume();
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({ workStatus: "completed" }));
    expect(parentReads).toBe(5);
    chat.scope.abort();
  });

  it("uses the terminal typed publication and its matching native artifact bytes", async () => {
    const body = "<!doctype html><p>Safe widget</p>";
    const artifact = {
      artifactId: "artifact-1", sourceOwnerId: "thought-A", revision: 1 as const, kind: "native_html" as const,
      mediaType: "text/html", sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
    };
    const publication = {
      utteranceId: "publication-A", publicSeq: 1, committedAt: "2026-11-07T01:00:00.000Z", inputIds: ["input-A"], sourceResults: [],
      blocks: [{ kind: "markdown", blockId: "text", text: "Public answer" },
        { kind: "artifact_ref", blockId: "widget", artifact }],
    };
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url === "/api/chat/dialogue/reply") return publicReply("dialogue-A", "publication-A", "Public answer", [
        { type: "data-dialogue-artifact", id: "artifact-1", data: { blockId: "widget", artifact, body } },
        { type: "data-dialogue-publication", id: "publication-A", data: publication },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(dialogueMetadata(chat.messages.at(-1)!).workStatus).toBe("completed"));
    const seat = dialogueStreamRows(chat.messages).workSeats.get("dialogue-work:assistant-A");
    const reply = seat?.replies?.[0];
    expect(reply?.kind).toBe("utterance");
    if (reply?.kind !== "utterance") throw new Error("Missing publication");
    expect(reply.utterance.blocks).toEqual(publication.blocks);
    expect(reply.artifactBodies?.get("artifact-1")).toBe(body);
    chat.scope.abort();
  });
});
