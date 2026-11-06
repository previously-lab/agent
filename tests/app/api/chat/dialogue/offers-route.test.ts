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

function call() {
  return GET(new Request(`http://localhost/api/chat/${parentId}/offers`), {
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
});