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
import { appendDialogueTurn, chatRequestMessages, dialogueMetadata, dialogueStreamRows } from "../dialogue-stream-rows";
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

function channel() {
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } });
  return { stream, emit: (chunk: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)) };
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
  const previews: string[] = [];
  const published = vi.fn();
  const controller = new DialogueParentController({
    persona: "fixture", signal: scope.signal, request, storage, retryDelayMs: 1,
    getMessages: () => messages,
    setMessages: update => {
      messages = update(messages);
      for (const message of messages) {
        const text = dialogueMetadata(message).replyPreview?.text;
        if (text && text !== previews.at(-1)) previews.push(text);
      }
    },
    onPublication: published,
  });
  return { controller, scope, storage, published, previews, get messages() { return messages; } };
}

function acceptedSeat(id = "A") {
  return appendDialogueTurn([], {
    id, role: "user", parts: [{ type: "text", text: `Question ${id}` }],
  }, `assistant-${id}`, "2026-11-15T00:00:00.000Z");
}

function liveActor() {
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } });
  const request: typeof fetch = async url => {
    if (String(url) === acceptance.offersUrl) return sse([{ type: "done", status: "running", retryAfterMs: 60000 }]);
    if (String(url).includes("/orchestrator?")) return Response.json({ runId: "actor", status: "running" });
    if (String(url) === "/api/chat/actor/stream?startIndex=0") return new Response(stream);
    throw new Error(String(url));
  };
  const chat = harness(request, memoryStorage(), acceptedSeat());
  chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
  const emit = (chunk: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
  const source = (extra: Record<string, unknown> = {}) => {
    emit({ type: "start", messageId: "final" });
    emit({ type: "data-dialogue-source", id: "final", data: { actorRunId: "actor", phase: "final_answer",
      offerId: "final", utteranceId: "final", inputIds: ["input-A"], sourceInputId: "input-A", workId: "work-A",
      parentRunId: "thought-A", ...extra } });
  };
  const wording = (text: string) => {
    emit({ type: "start-step" });
    emit({ type: "text-start", id: "block" });
    emit({ type: "text-delta", id: "block", delta: text });
  };
  const seat = () => dialogueStreamRows(chat.messages).workSeats.get("dialogue-work:assistant-A");
  return { chat, emit, source, wording, seat, disconnect: () => wire.close() };
}

describe("dialogue v2 Workflow publication history", () => {
  it("keeps active work across the record boundary and never restores an old or answered terminal parent as an empty reply", () => {
    const key = "previously:dialogue:parents:v2:fixture";
    const storage = memoryStorage();
    const cached = (name: string, done: boolean, acceptedAt: string) => ({
      ...acceptance, parentRunId: "thought-" + name, workId: "work-" + name, sourceInputId: "input-" + name,
      assistantId: "assistant-" + name, userMessage: acceptedSeat(name)[0], done, acceptedAt,
    });
    const old = "2026-11-22T06:30:00.000Z", boundary = "2026-11-22T08:32:00.000Z";
    storage.setItem(key, JSON.stringify([cached("outside", true, old), cached("active", false, old),
      cached("answered", true, boundary)]));
    const request = vi.fn(async () => Response.json({ runId: null, status: "idle" }));
    const client = harness(request, storage);
    client.controller.start({ since: boundary, savedPublications: new Set(["input-answered:call-final"]), answeredInputs: new Set(["input-answered"]) });
    expect(client.messages.map(message => message.id)).toEqual(["active", "assistant-active"]);
    expect(dialogueMetadata(client.messages[1]!).workStatus).toBe("running");
    client.scope.abort();
    const emptyWindow = harness(request, storage);
    emptyWindow.controller.start({ savedPublications: new Set(), answeredInputs: new Set() });
    expect(emptyWindow.messages.map(message => message.id)).toEqual(["active", "assistant-active"]);
    emptyWindow.scope.abort();
  });
  it("keeps unarchived terminal turns and restores the final while the archive only owns its partial", async () => {
    const key = "previously:dialogue:parents:v2:fixture";
    const storage = memoryStorage(), acceptedAt = "2026-11-22T06:30:00.000Z";
    const partial = utterance("early", ["input-0"], "Tuesday.", "commentary");
    const final = utterance("final", ["input-0"], "24 seats.");
    const records = Array.from({ length: 12 }, (_, index) => ({
      ...acceptance, parentRunId: `thought-${index}`, workId: `work-${index}`, sourceInputId: `input-${index}`,
      assistantId: `assistant-${index}`, userMessage: acceptedSeat(String(index))[0], done: true, acceptedAt,
      pendingPublications: index === 0 ? [partial, final] : [],
    }));
    storage.setItem(key, JSON.stringify(records));
    const client = harness(vi.fn(async () => Response.json({ runId: null, status: "idle" })), storage);
    client.controller.start({ savedPublications: new Set(["early"]), answeredInputs: new Set(["input-0"]) });
    await vi.waitFor(() => expect(JSON.parse(storage.getItem(key)!)[0].pendingPublications).toEqual([final]));
    expect(client.messages.filter(message => message.role === "user")).toHaveLength(12);
    expect(client.messages.filter(message => message.id.startsWith("dialogue-publication:")).map(message => message.id)).toEqual(["dialogue-publication:final"]);
    expect(JSON.parse(storage.getItem(key)!)).toHaveLength(12);
    client.scope.abort();
  });

  it("submits user attachments, committed content and native replay without tentative text or inline artifact bytes", () => {
    const user: UIMessage = { id: "user", role: "user", parts: [
      { type: "text", text: "My HTML is <b>user text</b>" }, { type: "file", mediaType: "image/png", url: "data:image/png;base64,fixture" },
    ], metadata: { attachments: ["upload"] } };
    const pub = utterance("final", ["input-A"], "Committed answer");
    const shared: UIMessage["parts"] = [{ type: "text", text: "Public words" }, { type: "data-dialogue-publication", data: pub },
      { type: "data-deepseek-step", data: { messages: [{ role: "assistant", content: "Native replay" }] } }];
    const assistant: UIMessage = { id: "assistant", role: "assistant", metadata: { workId: "work-A", replyPreview: {
      actorRunId: "actor", utteranceId: "next", text: "Tentative words" } }, parts: [...shared,
      { type: "data-dialogue-artifact", id: "html", data: { blockId: "chart", artifact: { artifactId: "html" }, body: "<p>Inline bytes</p>" } }] };
    const wire = JSON.parse(JSON.stringify(chatRequestMessages([assistant, user])));
    expect(wire).toEqual([{ id: "assistant", role: "assistant", metadata: { workId: "work-A" }, parts: [...shared,
      { type: "data-dialogue-artifact", id: "html", data: { blockId: "chart", artifact: { artifactId: "html" } } }] }, user]);
    expect(JSON.stringify(assistant)).toContain("Tentative words");
    expect(JSON.stringify(assistant)).toContain("<p>Inline bytes</p>");
  });

  it("keeps the current Actor's final preview across a delayed older wake and lease replay", async () => {
    const parent = channel(), older = channel(), current = channel();
    const request: typeof fetch = async url => {
      if (String(url) === acceptance.offersUrl) return new Response(parent.stream);
      if (String(url).includes("/orchestrator?")) return Response.json({ runId: "current", status: "running" });
      if (String(url) === "/api/chat/current/stream?startIndex=0") return new Response(current.stream);
      if (String(url) === "/api/chat/older/stream?startIndex=0") return new Response(older.stream);
      throw new Error(String(url));
    };
    const chat = harness(request, memoryStorage(), acceptedSeat());
    const begin = (wire: ReturnType<typeof channel>, runId: string, at: string) => {
      wire.emit({ type: "data-dialogue-lease_acquired", data: { at } });
      wire.emit({ type: "start", messageId: "candidate" });
      wire.emit({ type: "data-dialogue-source", data: { phase: "final_answer", actorRunId: runId, utteranceId: "candidate", offerId: "candidate",
        inputIds: ["input-A"], sourceInputId: "input-A", parentRunId: "thought-A", workId: "work-A" } });
      wire.emit({ type: "text-start", id: "words" });
    };
    const delta = (delta: string) => ({ type: "text-delta", id: "words", delta });
    const seat = () => dialogueStreamRows(chat.messages).workSeats.get("dialogue-work:assistant-A");
    try {
      chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
      begin(current, "current", "2026-11-15T00:02:00Z");
      current.emit(delta("Current"));
      await vi.waitFor(() => expect(seat()?.preview).toBe("Current"));
      parent.emit({ type: "dialogue_wake", runId: "older" });
      begin(older, "older", "2026-11-15T00:01:00Z");
      older.emit(delta("Stale words"));
      // A different final for the same input can precede a regeneration.
      older.emit({ type: "data-dialogue-publication", data: utterance("previous-final", ["input-A"], "Prior public answer") });
      await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
      expect(seat()?.preview).toBe("Current");
      expect(chat.previews).not.toContain("Stale words");
      current.emit(delta(" answer"));
      await vi.waitFor(() => expect(seat()?.preview).toBe("Current answer"));
      current.emit({ type: "data-dialogue-publication", data: utterance("candidate", ["input-A"], "Current answer") });
      await vi.waitFor(() => expect(chat.published).toHaveBeenCalledTimes(2));
      expect(seat()?.preview).toBeUndefined();
    } finally { chat.scope.abort(); }
  });

  it("reopens an idle Actor for a newer parent wake and renders its first final words before commit", async () => {
    const parent = channel(), first = channel(), replay = channel();
    let reads = 0;
    const request: typeof fetch = async url => {
      if (String(url) === acceptance.offersUrl) return new Response(parent.stream);
      if (String(url).includes("/orchestrator?")) return Response.json({ runId: null, status: "absent", runs: [] });
      if (String(url).includes("/actor/stream?")) return new Response(++reads === 1 ? first.stream : replay.stream);
      throw new Error(String(url));
    };
    const chat = harness(request, memoryStorage(), acceptedSeat());
    try {
      chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
      parent.emit({ type: "dialogue_wake", runId: "actor", wakeAt: "2026-11-22T13:29:23Z" });
      await vi.waitFor(() => expect(reads).toBe(1));
      first.emit({ type: "data-dialogue-exit_intent", data: { at: "2026-11-22T13:29:24Z" } });
      await new Promise(resolve => setTimeout(resolve, 0));
      parent.emit({ type: "dialogue_wake", runId: "actor", wakeAt: "2026-11-22T13:29:25Z" });
      await vi.waitFor(() => expect(reads).toBe(2));
      replay.emit({ type: "start", messageId: "final" });
      replay.emit({ type: "data-dialogue-source", data: { phase: "final_answer", actorRunId: "actor", utteranceId: "final", offerId: "final",
        inputIds: ["input-A"], sourceInputId: "input-A", parentRunId: "thought-A", workId: "work-A" } });
      replay.emit({ type: "text-start", id: "text" });
      replay.emit({ type: "text-delta", id: "text", delta: "First words" });
      await vi.waitFor(() => expect(chat.previews).toContain("First words"));
      expect(chat.published).not.toHaveBeenCalled();
    } finally { chat.scope.abort(); }
  });

  it("shows attributed final words before commit, replaces a retried attempt, and commits the verified artifact once", async () => {
    const { chat, emit, source, wording, seat } = liveActor();
    try {
      source();
      wording("First attempt.");
      await vi.waitFor(() => expect(seat()?.preview).toBe("First attempt."));
      expect(chat.published).not.toHaveBeenCalled();
      expect(chat.messages[1]?.parts).toEqual([]);
      wording("Final prefix");
      emit({ type: "reasoning-delta", id: "private", delta: "private reasoning" });
      emit({ type: "text-delta", id: "other", delta: "unattributed" });
      await vi.waitFor(() => expect(seat()?.preview).toBe("Final prefix"));
      const value = utterance("final", ["input-A"], "Final prefix and tail.");
      const artifact = { artifactId: "a", sourceOwnerId: "actor", revision: 1 as const, kind: "native_html" as const,
        mediaType: "text/html", byteSize: 4, sha256: "hash" };
      value.blocks.push({ kind: "artifact_ref", blockId: "html", artifact });
      emit({ type: "data-dialogue-artifact", id: "a", data: { blockId: "html", artifact, body: "<p/>" } });
      emit({ type: "data-dialogue-publication", data: value });
      emit({ type: "data-dialogue-publication", data: value });
      await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
      expect(seat()?.preview).toBeUndefined();
      const reply = seat()?.replies?.[0];
      expect(reply?.kind === "utterance" && reply.artifactBodies?.get("a")).toBe("<p/>");
      expect(chat.messages).toHaveLength(3);
    } finally { chat.scope.abort(); }
  });

  it.each([
    { phase: "commentary" }, { phase: undefined }, { actorRunId: "other" }, { parentRunId: "another-thought" },
    { workId: "other-work" }, { inputIds: ["input-A", "input-B"] }, { offerId: "other" },
  ])("holds unbound or interim wording until an attributed final begins (%j)", async extra => {
    const { chat, emit, source, wording, seat } = liveActor();
    try {
      source(extra);
      wording("Never displayed.");
      emit({ type: "reasoning-delta", id: "reason", delta: "Private." });
      // An acknowledged publication is an ordering barrier for the assertions.
      emit({ type: "data-dialogue-publication", data: utterance("opening", ["input-A"], "Earlier", "commentary") });
      await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
      expect(seat()?.preview).toBeUndefined();
      expect(JSON.stringify(chat.messages)).not.toContain("Never displayed.");
      expect(chat.previews).toEqual([]);
      source();
      wording("Attributed.");
      await vi.waitFor(() => expect(seat()?.preview).toBe("Attributed."));
      emit({ type: "data-turn-status", data: { status: "error", offerId: "final" } });
      await vi.waitFor(() => expect(seat()?.preview).toBeUndefined());
      expect(chat.published).toHaveBeenCalledOnce();
    } finally { chat.scope.abort(); }
  });

  it("discards artifact bodies from another owner or a different publication block", async () => {
    const { chat, emit, source, seat } = liveActor();
    try {
      source();
      const value = utterance("final", ["input-A"], "Summary");
      for (const [id, actor] of [["cross-owner", "other"], ["wrong-block", "actor"]]) {
        const artifact = { artifactId: id!, sourceOwnerId: actor!, revision: 1 as const, kind: "native_html" as const,
          mediaType: "text/html", byteSize: 4, sha256: "hash" };
        value.blocks.push({ kind: "artifact_ref", blockId: id!, artifact });
        emit({ type: "data-dialogue-artifact", id, data: { blockId: actor === "other" ? id : "another", artifact, body: "<p/>" } });
      }
      emit({ type: "data-dialogue-publication", data: value });
      await vi.waitFor(() => expect(chat.published).toHaveBeenCalledOnce());
      const reply = seat()?.replies?.[0];
      expect(reply?.kind === "utterance" && reply.artifactBodies?.size).toBe(0);
      expect(JSON.stringify(chat.messages)).not.toContain("<p/>");
    } finally { chat.scope.abort(); }
  });

  it("removes a truncated final preview and starts with an empty durable replay", async () => {
    const { chat, source, wording, seat, disconnect } = liveActor();
    try {
      source();
      wording("Incomplete");
      await vi.waitFor(() => expect(seat()?.preview).toBe("Incomplete"));
      disconnect();
      await vi.waitFor(() => expect(seat()?.preview).toBeUndefined());
      expect(chat.published).not.toHaveBeenCalled();
      expect(chat.messages).toHaveLength(2);
    } finally { chat.scope.abort(); }
  });
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

  it("continues after repeated temporary failures of the parent offers stream", async () => {
    let reads = 0;
    const request: typeof fetch = async url => {
      if (String(url) === acceptance.offersUrl) {
        if (++reads <= 5) return new Response(null, { status: 503 });
        return sse([{ type: "done", status: "completed", deliveryStatus: "delivered" }]);
      }
      return Response.json({ runId: null, status: "idle" });
    };
    const chat = harness(request, memoryStorage(), acceptedSeat());
    try {
      chat.controller.accept(acceptance, "assistant-A", chat.messages[0]);
      await vi.waitFor(() => expect(dialogueMetadata(chat.messages[1])).toMatchObject({ workConnection: "connected", workStatus: "completed" }));
      expect(reads).toBe(6);
    } finally { chat.scope.abort(); }
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

  it.each(["preparing", "wording"])("stops only A while the shared Actor is %s and keeps B streaming", async stage => {
    const actor = channel(), pendingA = channel(), pendingB = channel();
    const cancelled: string[] = [];
    const request: typeof fetch = async input => {
      const url = String(input);
      if (url === acceptance.offersUrl) return new Response(pendingA.stream);
      if (url === "/api/chat/thought-B/offers") return new Response(pendingB.stream);
      if (url.includes("/dialogue/orchestrator?")) return Response.json({ runId: "actor", status: "running" });
      if (url === "/api/chat/actor/stream?startIndex=0") return new Response(actor.stream);
      if (url.endsWith("/cancel")) { cancelled.push(url); return new Response(null, { status: 200 }); }
      throw new Error(url);
    };
    const initial = appendDialogueTurn(acceptedSeat(), acceptedSeat("B")[0], "assistant-B", "2026-11-15T00:01:00.000Z");
    const chat = harness(request, memoryStorage(), initial);
    const seat = (id: string) => dialogueStreamRows(chat.messages).workSeats.get(`dialogue-work:assistant-${id}`);
    const begin = (id: string) => {
      actor.emit({ type: "start", messageId: `final-${id}` });
      actor.emit({ type: "data-dialogue-source", data: { phase: "final_answer", actorRunId: "actor", utteranceId: `final-${id}`,
        offerId: `final-${id}`, inputIds: [`input-${id}`], sourceInputId: `input-${id}`, parentRunId: `thought-${id}`, workId: `work-${id}` } });
      actor.emit({ type: "text-start", id: "text" });
    };
    const delta = (text: string) => actor.emit({ type: "text-delta", id: "text", delta: text });
    try {
      chat.controller.accept(acceptance, "assistant-A", initial[0]);
      chat.controller.accept({ ...acceptance, sourceInputId: "input-B", workId: "work-B", parentRunId: "thought-B",
        offersUrl: "/api/chat/thought-B/offers" }, "assistant-B", initial[2]);
      actor.emit({ type: "data-dialogue-publication", data: utterance("early-A", ["input-A"], "Already public.", "commentary") });
      await vi.waitFor(() => expect(seat("A")?.replies).toHaveLength(1));
      if (stage === "wording") {
        begin("A"); delta("Draft A");
        await vi.waitFor(() => expect(seat("A")?.preview).toBe("Draft A"));
      }
      await chat.controller.stop("work-A");
      begin("A"); delta("Late A draft");
      begin("B"); delta("B continues");
      await vi.waitFor(() => expect(seat("B")?.preview).toBe("B continues"));
      expect(cancelled).toEqual(["/api/chat/thought-A/cancel"]);
      expect(seat("A")?.work.status).toBe("cancelled");
      expect(seat("A")?.preview).toBeUndefined();
      expect(chat.previews).not.toContain("Late A draft");
      expect(seat("A")?.replies?.map(reply => reply.id)).toEqual(["early-A"]);
      actor.emit({ type: "data-dialogue-publication", data: utterance("final-B", ["input-B"], "B complete.") });
      await vi.waitFor(() => expect(seat("B")?.replies?.map(reply => reply.id)).toEqual(["final-B"]));
    } finally { chat.scope.abort(); }
  });
});
