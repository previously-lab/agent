import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("workflow/api", () => ({ getRun: h.getRun }));

import { listDialogueOffers, readDialogueAdmission } from "@/lib/dialogue/workflow-offers";
import { DIALOGUE_OFFERS_NAMESPACE } from "@/lib/dialogue/transport";

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
});