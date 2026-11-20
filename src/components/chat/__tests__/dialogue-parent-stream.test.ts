import { describe, expect, it, vi } from "vitest";
import type { PublicUtterance } from "@/lib/chat/dialogue-contract";
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

function utterance(id: string, inputIds: string[], text: string, phase: "commentary" | "final_answer" = "final_answer"): PublicUtterance {
  return {
    utteranceId: id, publicSeq: 1, committedAt: "2026-11-15T00:00:00.000Z", inputIds,
    sourceResults: [{ resultId: id, productRevision: 1, claimIds: [] }],
    blocks: [{ kind: "markdown", blockId: `${id}:text`, text }], phase,
  };
}

function sse(events: Array<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function publicationStream(values: PublicUtterance[]) {
  const events = values.flatMap(value => [
    { type: "start", messageId: value.utteranceId },
    {
      type: "data-dialogue-source", id: `${value.utteranceId}:source`,
      data: { offerId: value.utteranceId, sourceInputId: value.inputIds[0], workId: `work-${value.inputIds[0]}`, parentRunId: "orchestrator-1" },
    },
    { type: "data-dialogue-publication", id: value.utteranceId, data: value },
  ]);
  return sse([...events, { type: "finish" }]);
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

function harness(request: typeof fetch, storage = memoryStorage(), initial: UIMessage[] = []) {
  const scope = new AbortController();
  let messages = initial;
  const published = vi.fn();
  const controller = new DialogueParentController({
    persona: "fixture", signal: scope.signal, request, storage, retryDelayMs: 1,
    getMessages: () => messages,
    setMessages: update => { messages = update(messages); },
    onPublication: published,
  });
  return { controller, scope, storage, published, get messages() { return messages; } };
}

function acceptedSeat(id = "A") {
  return appendDialogueTurn([], {
    id, role: "user", parts: [{ type: "text", text: `Question ${id}` }],
  }, `assistant-${id}`, "2026-11-15T00:00:00.000Z");
}

describe("dialogue v2 Workflow publication history", () => {
  it("validates envelopes and the submitted user", () => {
    expect(parseDialogueAcceptedV2(acceptance)).toEqual(acceptance);
    expect(() => parseDialogueAcceptedV2({ ...acceptance, version: 1 })).toThrow("Invalid dialogue acceptance");
    expect(parseDialogueParentEvent({ type: "done", status: "completed" })).toEqual({ type: "done", status: "completed" });
    const messages = acceptedSeat();
    expect(parseSubmittedUserMessage({ messages })?.id).toBe("A");
    expect(parseSubmittedUserMessage({ regenerate: true, dialogueInputId: "A", messages })?.id).toBe("A");
  });

  it("keeps commentary and final in one work without a direct reply", async () => {
    const publications = [
      utterance("opening", ["input-A"], "我先看一下。", "commentary"),
      utterance("final", ["input-A"], "最终答案。"),
    ];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({ runId: "orchestrator-1", status: "running" });
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") return publicationStream(publications);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledTimes(2));
    const seat = dialogueStreamRows(chat.messages).workSeats.get("dialogue-work:assistant-A");
    expect(seat?.work.status).toBe("completed");
    expect(seat?.replies?.map(reply => reply.id)).toEqual(["opening", "final"]);
    expect(request).not.toHaveBeenCalledWith("/api/chat/dialogue/reply", expect.anything());
    chat.scope.abort();
  });

  it.each(["completed", "failed"])("reconciles a legacy cached reply failure with the server's %s verdict once", async status => {
    const storage = memoryStorage();
    const key = "previously:dialogue:parents:v2:fixture";
    storage.setItem(key, JSON.stringify([{ ...acceptance, failed: true, done: true,
      acceptedAt: "2026-11-15T00:00:00Z", assistantId: "assistant-A", userMessage: acceptedSeat()[0] }]));
    const request = vi.fn(async (url: RequestInfo | URL) => String(url) === acceptance.offersUrl
      ? sse([{ type: "dialogue_wake", runId: "oldActor" }, { type: "done", status,
          ...(status === "completed" ? { deliveryStatus: "delivered" } : {}) }])
      : Response.json({ runId: null, status: "idle" }));
    const client = harness(request, storage, acceptedSeat());
    client.controller.start();
    await vi.waitFor(() => expect(JSON.parse(storage.getItem(key)!)[0]).toMatchObject({
      done: true, failed: status === "failed", failureVerified: status === "failed",
    }));
    expect(dialogueMetadata(client.messages.find(message => message.id === "assistant-A")!).workStatus).toBe(status);
    client.scope.abort();
    const reopened = harness(request, storage, acceptedSeat());
    reopened.controller.start();
    expect(request.mock.calls.filter(([url]) => String(url) === acceptance.offersUrl)).toHaveLength(1);
    expect(request.mock.calls.some(([url]) => String(url).includes("oldActor"))).toBe(false);
    reopened.scope.abort();
  });

  it.each([{}, { deliveryStatus: "unverified" }])("retains an older cached failure when delivery cannot be established (%j)", async fields => {
    const storage = memoryStorage();
    const key = "previously:dialogue:parents:v2:fixture";
    storage.setItem(key, JSON.stringify([{ ...acceptance, failed: true, done: true,
      acceptedAt: "2026-11-15T00:00:00Z", assistantId: "assistant-A", userMessage: acceptedSeat()[0] }]));
    let finished = false;
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) !== acceptance.offersUrl) return Response.json({ runId: null, status: "idle" });
      finished = true;
      return sse([{ type: "done", status: "completed", ...fields }]);
    });
    const client = harness(request, storage, acceptedSeat());
    client.controller.start();
    await vi.waitFor(() => expect(finished).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(storage.getItem(key)!)[0]).toMatchObject({ failed: true });
    expect(dialogueMetadata(client.messages.find(message => message.id === "assistant-A")!).workStatus).toBe("failed");
    client.scope.abort();
  });

  it("publishes B before A without moving fixed work seats", async () => {
    const publications = [
      utterance("answer-B", ["input-B"], "Answer B"),
      utterance("answer-A", ["input-A"], "Answer A"),
    ];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl || url === "/api/chat/thought-B/offers") return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({ runId: "orchestrator-1", status: "running" });
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") return publicationStream(publications);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), [...acceptedSeat("A"), ...acceptedSeat("B")]);
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    chat.controller.accept({ ...acceptance, parentRunId: "thought-B", sourceInputId: "input-B", workId: "work-B",
      offersUrl: "/api/chat/thought-B/offers", thoughtsUrl: "/api/chat/thought-B/thoughts" }, "assistant-B", chat.messages[2]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledTimes(2));
    const rows = dialogueStreamRows(chat.messages);
    expect(rows.workSeats.get("dialogue-work:assistant-A")?.replies?.[0]?.id).toBe("answer-A");
    expect(rows.workSeats.get("dialogue-work:assistant-B")?.replies?.[0]?.id).toBe("answer-B");
    expect(rows.items.map(item => item.key)).toEqual([
      "dialogue-input:A", "dialogue-work:assistant-A", "dialogue-input:B", "dialogue-work:assistant-B",
    ]);
    chat.scope.abort();
  });

  it("dedupes replayed publications and manual resume", async () => {
    const publications = [utterance("once", ["input-A"], "Once")];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({ runId: "orchestrator-1", status: "running" });
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") return publicationStream(publications);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
    chat.controller.resume();
    expect(chat.messages.filter(message => dialogueMetadata(message).publicationId === "once")).toHaveLength(1);
    expect(chat.published).toHaveBeenCalledOnce();
    chat.scope.abort();
  });

  it("renders a merged publication once in its own utterance seat", async () => {
    const publications = [utterance("merged", ["input-A", "input-B"], "Merged answer")];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl || url === "/api/chat/thought-B/offers") return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({ runId: "orchestrator-1", status: "running" });
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") return publicationStream(publications);
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), [...acceptedSeat("A"), ...acceptedSeat("B")]);
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    chat.controller.accept({ ...acceptance, parentRunId: "thought-B", sourceInputId: "input-B", workId: "work-B",
      offersUrl: "/api/chat/thought-B/offers", thoughtsUrl: "/api/chat/thought-B/thoughts" }, "assistant-B", chat.messages[2]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
    const rows = dialogueStreamRows(chat.messages);
    expect(rows.utterances.get("dialogue-utterance:merged")?.publications[0]?.utterance.inputIds).toEqual(["input-A", "input-B"]);
    expect(rows.workSeats.get("dialogue-work:assistant-A")?.replies).toBeUndefined();
    expect(rows.workSeats.get("dialogue-work:assistant-B")?.replies).toBeUndefined();
    chat.scope.abort();
  });

  it("skips terminal runs and dedupes a repeated live publication", async () => {
    const attached: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({
        runId: "orchestrator-new", status: "running",
        runs: [
          { runId: "orchestrator-new", status: "running", createdAt: "2026-11-15T00:02:00.000Z" },
          { runId: "orchestrator-old", status: "completed", createdAt: "2026-11-15T00:01:00.000Z" },
        ],
      });
      if (url === "/api/chat/orchestrator-old/stream?startIndex=0") {
        attached.push(url);
        return publicationStream([utterance("from-old-run", ["input-A"], "Saved answer")]);
      }
      if (url === "/api/chat/orchestrator-new/stream?startIndex=0") {
        attached.push(url);
        return publicationStream([utterance("from-old-run", ["input-A"], "Saved answer")]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/api/chat/orchestrator-new/stream?startIndex=0", expect.anything()));
    expect(chat.published).toHaveBeenCalledOnce();
    expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({ publicationId: "from-old-run" });
    expect(attached).toEqual(["/api/chat/orchestrator-new/stream?startIndex=0"]);
    chat.scope.abort();
  });

  it("does not attach a terminal Workflow run reported by discovery", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({
        runId: "orchestrator-terminal", status: "completed",
        runs: [{ runId: "orchestrator-terminal", status: "completed" }],
      });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/api/chat/dialogue/orchestrator?persona=fixture", expect.anything()));
    expect(chat.published).not.toHaveBeenCalled();
    chat.scope.abort();
  });

  it("uses wake and continued events without polling orchestrator discovery", async () => {
    let discoveries = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "dialogue_wake", runId: "orchestrator-1" }, { type: "done", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) {
        discoveries++;
        return Response.json({ runId: null, status: "absent", runs: [] });
      }
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") return sse([
        { type: "data-dialogue-continued", id: "continue-1", data: { type: "continued", nextRunId: "orchestrator-2" } },
        { type: "finish" },
      ]);
      if (url === "/api/chat/orchestrator-2/stream?startIndex=0") {
        return publicationStream([utterance("after-handoff", ["input-A"], "Delivered after handoff")]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    expect(parseDialogueParentEvent({ type: "dialogue_wake", runId: "orchestrator-1" })).toEqual({
      type: "dialogue_wake", runId: "orchestrator-1",
    });
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(discoveries).toBe(1);
    expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({ publicationId: "after-handoff" });
    chat.scope.abort();
  });

  it("recovers truncated output on the same run until the server closes it", async () => {
    const opening = { type: "data-dialogue-publication", data: utterance("opening", ["input-A"], "Starting", "commentary") };
    let reads = 0;
    let discoveries = 0;
    const request = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) {
        discoveries++;
        return Response.json({ runId: "orchestrator-1", status: "running" });
      }
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") {
        if (++reads === 1) return new Response(`data: ${JSON.stringify(opening)}\n\n`);
        return sse([opening, { type: "data-dialogue-publication", data: utterance("final", ["input-A"], "Finished") }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const chat = harness(request, memoryStorage(), acceptedSeat());
    try {
      chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
      await vi.waitFor(() => expect(chat.published).toHaveBeenCalledTimes(2));
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(reads).toBe(2);
      expect(discoveries).toBe(1);
    } finally {
      chat.scope.abort();
    }
  });

  it("retries a temporary server failure and stops when the run is unavailable", async () => {
    let reads = 0;
    const request = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) {
        return Response.json({ runId: "orchestrator-1", status: "running" });
      }
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") {
        if (++reads === 1) return new Response(null, { status: 503 });
        return Response.json({ error: "Run not available for reconnect" }, { status: 404 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const chat = harness(request, memoryStorage(), acceptedSeat());
    try {
      chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
      await vi.waitFor(() => expect(reads).toBe(2));
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(reads).toBe(2);
    } finally {
      chat.scope.abort();
    }
  });

  it("ignores a duplicate wake for an already completed orchestrator", async () => {
    let streamReads = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([
        { type: "dialogue_wake", runId: "orchestrator-1" },
        { type: "dialogue_wake", runId: "orchestrator-1" },
        { type: "done", status: "completed" },
      ]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({ runId: null, status: "absent", runs: [] });
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") {
        streamReads++;
        return publicationStream([utterance("wake-once", ["input-A"], "Once")]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(streamReads).toBe(1);
    chat.scope.abort();
  });

  it("does not rediscover or replay a completed orchestrator on resume", async () => {
    let discoveries = 0;
    let streamReads = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "completed" }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) {
        discoveries++;
        return Response.json({ runId: "orchestrator-1", status: "running" });
      }
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") {
        streamReads++;
        return publicationStream([utterance("once-after-resume", ["input-A"], "Once")]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
    chat.controller.resume();
    chat.controller.resume();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(discoveries).toBe(1);
    expect(streamReads).toBe(1);
    expect(chat.published).toHaveBeenCalledOnce();
    chat.scope.abort();
  });

  it("cancels the thought and current orchestrator run on stop", async () => {
    const cancelled: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === acceptance.offersUrl) return sse([{ type: "done", status: "running", retryAfterMs: 1 }]);
      if (url.startsWith("/api/chat/dialogue/orchestrator?")) return Response.json({ runId: "orchestrator-1", status: "running" });
      if (url === "/api/chat/orchestrator-1/stream?startIndex=0") return publicationStream([]);
      if (url.endsWith("/cancel")) {
        cancelled.push(url);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const chat = harness(request, memoryStorage(), acceptedSeat());
    chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/api/chat/orchestrator-1/stream?startIndex=0", expect.anything()));
    await chat.controller.stop("work-A");
    expect(cancelled).toEqual(["/api/chat/thought-A/cancel", "/api/chat/orchestrator-1/cancel"]);
    expect(dialogueMetadata(chat.messages.at(-1)!)).toMatchObject({ workStatus: "cancelled" });
    chat.scope.abort();
  });
});
