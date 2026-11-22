import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("workflow/api", () => ({ getRun: h.getRun }));

import { DIALOGUE_OFFERS_NAMESPACE } from "@/lib/dialogue/transport";
import { createNextDataCacheContext } from "../../../../helpers/next-data-cache-context";
const cache = createNextDataCacheContext();
const { listDialogueEvents, listDialogueOffers, readDialogueAdmission } = await import("@/lib/dialogue/workflow-offers");

const first = { type: "offer", offerId: "work:call", runId: "wrun_01JTESTCHILD00000000000000", sourceInputId: "input" };
const duplicate = { ...first, runId: "wrun_01JTESTOTHER00000000000000" };

function parent(status: string, chunks: unknown[]) {
  return {
    status: Promise.resolve(status),
    getReadable: (options: { namespace?: string }) => {
      expect(options.namespace).toBe(DIALOGUE_OFFERS_NAMESPACE);
      const readable = new ReadableStream<unknown>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return Object.assign(readable, { getTailIndex: async () => chunks.length - 1 });
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("parent native offer control", () => {
  it("replays SDK-decoded offers and selects the first stable offerId", async () => {
    h.getRun.mockReturnValue(parent("running", [first, duplicate, { type: "other" }]));
    await expect(listDialogueOffers("wrun_01JTESTPARENT0000000000000")).resolves.toEqual([first]);
    await expect(readDialogueAdmission("wrun_01JTESTPARENT0000000000000", "work:call", first.runId)).resolves.toBe("admitted");
    await expect(readDialogueAdmission("wrun_01JTESTPARENT0000000000000", "work:call", duplicate.runId)).resolves.toBe("duplicate");
  });

  it("waits only while the known parent is live", async () => {
    h.getRun.mockReturnValue(parent("running", []));
    await expect(readDialogueAdmission("wrun_01JTESTPARENT0000000000000", "missing", first.runId)).resolves.toBe("pending");
    h.getRun.mockReturnValue(parent("completed", []));
    await expect(readDialogueAdmission("wrun_01JTESTPARENT0000000000000", "missing", first.runId)).resolves.toBe("parent_terminal");
  });

  it("cancels a live snapshot reader after the captured tail", async () => {
    const cancel = vi.fn();
    const readable = new ReadableStream<unknown>({
      start(controller) { controller.enqueue(first); },
      cancel,
    });
    h.getRun.mockReturnValue({ getReadable: () => Object.assign(readable, { getTailIndex: async () => 0 }) });
    await expect(listDialogueOffers("wrun_01JTESTPARENT0000000000000")).resolves.toEqual([first]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("replays a verified prefix, rechecks appends and retries early EOF at the same tail", async () => {
    const second = { ...first, offerId: "second" }, third = { ...first, offerId: "third" };
    let chunks = [first], tail = 1, fetches = 0;
    h.getRun.mockReturnValue({ getReadable: () => ({
      getTailIndex: async () => tail,
      getReader: () => {
        fetches++;
        return new ReadableStream({ start(controller) {
          for (const item of chunks) controller.enqueue(item);
          controller.close();
        } }).getReader();
      },
    }) });
    const sample = async () => {
      const result = await cache.run(() => listDialogueEvents("completed", "scope"));
      await cache.run(() => cache.flush());
      return result;
    };
    expect(await sample()).toEqual([first]);
    chunks = [first, second];
    expect(await sample()).toEqual([first, second]);
    expect(await sample()).toEqual([first, second]);
    expect(fetches).toBe(2);
    tail = 2; chunks.push(third);
    expect(await sample()).toEqual([first, second, third]);
    expect(fetches).toBe(3);
  });
});
