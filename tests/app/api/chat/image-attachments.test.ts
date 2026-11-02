import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ start: vi.fn(), reserve: vi.fn(), confirm: vi.fn(), release: vi.fn() }));
vi.mock("@/app/api/chat/start-turn", () => ({ startTurn: state.start }));
vi.mock("@/lib/tools/staged-images", () => ({ reserveStagedImages: state.reserve }));
vi.mock("@/lib/chat/server-stream", () => ({ createUIMessageStreamResponse: ({ headers }: { headers: HeadersInit }) => new Response("fixture stream", { headers }) }));
vi.mock("@/app/api/chat/mixed-stream-transform", () => ({ createMixedStreamTransform: () => new TransformStream() }));
import { POST } from "@/app/api/chat/route";
import { ImageAttachmentError } from "@/lib/tools/image-validation";
const assetId = `img_${"a".repeat(32)}`;
function request(extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify({ messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "See 〔图2〕" }] }], stagedAttachments: [{ assetId, ordinal: 2 }], ...extra }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  state.confirm.mockResolvedValue(undefined); state.release.mockResolvedValue(undefined);
  state.reserve.mockResolvedValue({ attachments: [], confirm: state.confirm, release: state.release });
  state.start.mockResolvedValue({ runId: "fixture-run", readable: new ReadableStream({ start(controller) { controller.close(); } }) });
});
describe("image submission acceptance boundary", () => {
  it("confirmed workflow acceptance still returns its run ID when manifest confirmation fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.confirm.mockRejectedValue(new Error("fixture disk offline"));
    const response = await POST(request());
    expect(response.status).toBe(200); expect(response.headers.get("x-workflow-run-id")).toBe("fixture-run");
    expect(await response.text()).toBe("fixture stream"); expect(state.release).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled(); log.mockRestore();
  });
  it("a rejected start rolls back and rollback failure cannot replace its original 4xx", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.start.mockRejectedValue(new ImageAttachmentError("fixture_rejected", "original rejection", 409));
    state.release.mockRejectedValue(new Error("fixture cleanup unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "original rejection", code: "fixture_rejected" });
    expect(state.confirm).not.toHaveBeenCalled(); expect(state.release).toHaveBeenCalledOnce(); log.mockRestore();
  });
  it("invalid message shape is rejected before reserving images", async () => {
    const response = await POST(request({ messages: [{ id: "broken", role: "user", parts: "not parts" }] }));
    expect(response.status).toBe(400); expect(state.reserve).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled();
  });
  it("only server evidence feeds the workflow, with raw prose unchanged", async () => {
    const snapshot = { version: 1, assetId, ordinal: 2, ref: `drafts/${assetId}`, name: "real.png", mediaType: "image/png", byteSize: 3 };
    const verified = [{ snapshot, dataBase64: "AQID" }];
    state.reserve.mockResolvedValue({ attachments: verified, confirm: state.confirm, release: state.release });
    const response = await POST(request({ verifiedImages: [{ path: "../secret", dataBase64: "bad" }] }));
    expect(response.status).toBe(200);
    const input = state.start.mock.calls[0][0];
    expect(input.verifiedImages).toEqual(verified); expect(input.originalUserText).toBe("See 〔图2〕");
    expect(input.messages[0].parts[1].text).toContain('〔图2〕 = real.png');
    expect(input.messages[0].parts[1].text).toContain('source="attachment:0"');
    expect(JSON.stringify(input)).not.toContain("../secret");
  });
});
