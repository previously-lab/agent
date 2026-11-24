import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { digest } from "@/lib/dialogue/artifacts";
import { restoreDialogueImages } from "@/lib/dialogue/regeneration-images";

const h = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), events: vi.fn(), locate: vi.fn(), readPage: vi.fn(), parse: vi.fn(), readImage: vi.fn() }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { get: h.get, list: h.list } }) }));
vi.mock("@/lib/dialogue/workflow-offers", () => ({ listDialogueEvents: h.events }));
vi.mock("@/lib/episodic/manager", () => ({ parseSlice: h.parse }));
vi.mock("@/lib/episodic/paths", () => ({ readSlicePartResolved: h.readPage }));
vi.mock("@/lib/tools/attachments", () => ({ readRecordImage: h.readImage }));
vi.mock("@/lib/chat/summary-records", () => ({ locateSummaryRecords: h.locate }));

const scope = "fixture-scope", clientMessageId = "original-client-id", acceptedAt = "2026-11-23T07:20:10.000Z";
const inputId = digest(JSON.stringify([scope, clientMessageId])).slice(0, 24);
const assetId = `img_${"a".repeat(32)}`, page = "records/2026/11/23/0720/";
const original: ImageAttachmentSnapshot = { version: 1, assetId, ref: `drafts/${assetId}`, name: "original.png", mediaType: "image/png", ordinal: 3 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
const recorded = { ...original, ref: page + inputId + "-" + assetId + ".png", byteSize: png.length };
const forged = { ...original, ordinal: 1, ref: page + "other.png" };
const row = { runId: "wrun_ORIGINAL", attributes: { role: "thinking", turn: inputId, work: inputId, scope } };
const user = { role: "user", turnId: inputId, clientMessageId, timestamp: acceptedAt, content: "Original question.",
  dialogue: { kind: "user_input", inputId }, attachments: [recorded] };
const slice = { slice_id: "2026-11-23-0720", turns: [user] };

beforeEach(() => {
  vi.resetAllMocks(); h.list.mockResolvedValue({ data: [] }); h.events.mockResolvedValue([]); h.locate.mockResolvedValue({ saved: new Map() });
  h.readImage.mockResolvedValue({ data: png, mediaType: "image/png" });
});

describe("scoped original images for dialogue regeneration", () => {
  it("restores the accepted image from the original work before the record has landed", async () => {
    h.get.mockResolvedValue(row);
    const images = [{ snapshot: original, dataBase64: png.toString("base64") }];
    h.events.mockResolvedValue([{ type: "thought_started", runId: row.runId, sourceInputId: inputId, workId: inputId,
      input: { inputId, clientMessageId, acceptedAt, text: "Original question." }, record: { images } }]);
    const restored = await restoreDialogueImages(scope, inputId, row.runId, [{ ...original, ordinal: 41, name: "client.png" }]);
    expect(restored).toEqual({ clientMessageId, text: "Original question.", acceptedAt, images });
    expect(h.readPage).not.toHaveBeenCalled(); expect(h.readImage).not.toHaveBeenCalled();
  });

  it("uses only the bound record's original attachment even with a forged filename or ordinal", async () => {
    h.readPage.mockResolvedValue({ content: "core" }); h.parse.mockReturnValue(slice);
    const restored = await restoreDialogueImages(scope, inputId, undefined, [forged]);
    expect(h.readImage.mock.calls).toEqual([[recorded.ref]]);
    expect(restored.images).toEqual([{ snapshot: recorded, dataBase64: png.toString("base64") }]);
    expect(h.get).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
  });

  it("restores an archived input beyond the workflow registry window even when the browser still has its draft reference", async () => {
    h.locate.mockResolvedValue({ saved: new Map([[inputId, slice]]) });
    const result = await restoreDialogueImages(scope, inputId, undefined, [original]);
    expect(result.images[0].snapshot).toEqual(recorded);
    expect(h.readImage.mock.calls).toEqual([[recorded.ref]]);
  });

  it("rejects a different scope or input, before reading any image or workflow events", async () => {
    h.readPage.mockResolvedValue({ content: "core" }); h.parse.mockReturnValue({ turns: [user] }); h.get.mockResolvedValue(row);
    for (const [wantedScope, wantedInput] of [["other", inputId], [scope, "f".repeat(24)]]) {
      await expect(restoreDialogueImages(wantedScope, wantedInput, row.runId, [forged])).rejects.toMatchObject({ status: 409 });
    }
    expect(h.events).not.toHaveBeenCalled(); expect(h.readImage).not.toHaveBeenCalled();
  });
});
