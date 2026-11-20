import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("workflow/api", () => ({ getRun: h.getRun }));

import { GET } from "@/app/api/chat/[runId]/offers/route";

const parentId = "wrun_01JTESTPARENT0000000000000";
const offer = { type: "offer", offerId: "work:call", runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input" };

function runWith(status: string, chunks: unknown[], result: unknown = {}) {
  let reads = 0;
  const readable = new ReadableStream<unknown>({
    pull(controller) {
      if (reads < chunks.length) controller.enqueue(chunks[reads++]);
      // Deliberately leave an unclosed tail: terminal recovery must not hang.
    },
  });
  return {
    status: Promise.resolve(status),
    returnValue: Promise.resolve(result),
    getReadable: () => Object.assign(readable, { getTailIndex: async () => chunks.length - 1 }),
  };
}

function call(query = "") {
  return GET(new Request(`http://localhost/api/chat/${parentId}/offers${query}`), {
    params: Promise.resolve({ runId: parentId }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("parent offer stream recovery", () => {
  it("drains offers and finishes on a terminal parent even when the stream stayed open", async () => {
    h.getRun.mockReturnValue(runWith("completed", [offer]));
    const text = await (await call()).text();
    expect(text).toContain('"type":"offer"');
    expect(text).toContain('"offerId":"work:call"');
    expect(text).toContain('"type":"done"');
    expect(text).toContain('"status":"completed"');
  });

  it("reports no-offer parent failure without inventing a reply", async () => {
    h.getRun.mockReturnValue(runWith("completed", [], { error: "no result" }));
    const text = await (await call()).text();
    expect(text).not.toContain('"type":"offer"');
    expect(text).toContain('"status":"failed"');
  });

  it.each([["delivered", "completed"], ["failed", "failed"]])(
    "reports the public delivery witness %s when an older private run also recorded an error",
    async (delivery, expected) => {
      h.getRun.mockReturnValue(runWith("completed", [], {
        dialogueDelivery: { status: delivery, candidateId: "work:call" },
        error: "The thinking run ended without a work result.",
      }));
      const text = await (await call()).text();
      expect(text).toContain(`"status":"${expected}"`);
      if (delivery === "delivered") expect(text).toContain('"deliveryStatus":"delivered"');
    },
  );

  it.each(["returnValue", "priorFinal", "stream"])("marks a completed run as unverified when reading %s fails", async source => {
    const run = runWith("completed", [], { error: "private failure" });
    const unreadable = () => { throw new Error("temporary read failure"); };
    if (source === "returnValue") Object.defineProperty(run, "returnValue", { get: unreadable });
    if (source === "stream") run.getReadable = unreadable;
    h.getRun.mockReturnValueOnce(run).mockImplementation(unreadable);
    const text = await (await call(source === "priorFinal" ? "?startIndex=2" : "")).text();
    expect(text).toContain('"deliveryStatus":"unverified"');
    expect(text).not.toContain('"deliveryStatus":"delivered"');
  });

  it("does not mistake an interim offer for a final reply after the parent fails", async () => {
    h.getRun.mockReturnValue(runWith("completed", [{ ...offer, stage: "checkpoint", publicSeq: 1 }], { error: "no final result" }));
    const text = await (await call()).text();
    expect(text).toContain('"stage":"checkpoint"');
    expect(text).toContain('"status":"failed"');
  });
});
