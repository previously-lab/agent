import { describe, expect, it, vi } from "vitest";
import { createImageAttachmentDraft, IMAGE_INPUT_MAX_BYTES } from "@/lib/chat/image-attachment-draft";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";

const file = (name = "photo.png") => new File(["fixture"], name, { type: "image/png" });
const attachment = (n: number): ImageAttachmentSnapshot => ({ version: 1, assetId: `img_${String(n).padStart(32, "0")}`, ref: `drafts/img_${String(n).padStart(32, "0")}`, name: "photo.png", mediaType: "image/png" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
function setup() {
  let id = 0;
  const uploads: ReturnType<typeof deferred<ImageAttachmentSnapshot>>[] = [];
  const prepare = vi.fn(async (input: File) => input);
  const cancel = vi.fn(async (_assetId: string) => {});
  const draft = createImageAttachmentDraft({ prepare, cancel, mintId: () => `local-${++id}`, upload: vi.fn(() => {
    const pending = deferred<ImageAttachmentSnapshot>(); uploads.push(pending); return pending.promise;
  }) });
  return { draft, uploads, prepare, cancel };
}

describe("image draft ownership", () => {
  it("retains prepared aspect ratio through upload failure, retry and undo", async () => {
    const pending = deferred<ImageAttachmentSnapshot>();
    const draft = createImageAttachmentDraft({
      prepare: async input => ({ file: input, width: 600, height: 420 }),
      upload: () => pending.promise, cancel: async () => {}, mintId: () => "photo",
    });
    const [image] = draft.add([file()]);
    await tick();
    expect(draft.getSnapshot().images[0]).toMatchObject({ status: "uploading", width: 600, height: 420 });
    pending.reject(new Error("offline")); await tick();
    expect(draft.getSnapshot().images[0]).toMatchObject({ status: "error", width: 600, height: 420 });
    draft.retry(image.localClientId);
    expect(draft.getSnapshot().images[0]).toMatchObject({ status: "preparing", width: 600, height: 420 });
    draft.remove(image.localClientId); draft.undo();
    expect(draft.getSnapshot().images[0]).toMatchObject({ status: "preparing", width: 600, height: 420 });
    draft.dispose(); await tick();
  });

  it("allocates ordinals before upload and never reindexes reverse completions or removals", async () => {
    const { draft, uploads, cancel } = setup();
    const [one, two] = draft.add([file("one.png"), file("two.png")]);
    await tick(); uploads[1].resolve(attachment(2)); await tick();
    expect(draft.getSnapshot().images.map(image => [image.ordinal, image.status])).toEqual([[1, "uploading"], [2, "ready"]]);
    uploads[0].resolve(attachment(1)); await tick(); draft.remove(one.localClientId);
    expect(cancel).toHaveBeenCalledWith(attachment(1).assetId);
    expect(draft.getSnapshot().images[0]).toMatchObject({ localClientId: two.localClientId, ordinal: 2 });
    expect(draft.add([file("three.png")])[0].ordinal).toBe(3);
  });

  it("cancels late success after remove/dispose; undo keeps ordinal with fresh upload ownership", async () => {
    const { draft, uploads, cancel } = setup();
    const [one] = draft.add([file()]); await tick();
    draft.remove(one.localClientId); draft.undo(); await tick();
    uploads[0].resolve(attachment(1)); await tick();
    expect(cancel).toHaveBeenCalledWith(attachment(1).assetId);
    expect(draft.getSnapshot().images[0]).toMatchObject({ ordinal: 1, status: "uploading" });
    uploads[1].resolve(attachment(2)); await tick();
    draft.add([file("later.png")]); await tick(); draft.dispose();
    uploads[2].resolve(attachment(3)); await tick();
    expect(cancel.mock.calls.map(call => call[0])).toEqual([attachment(1).assetId, attachment(2).assetId, attachment(3).assetId]);
    expect(draft.getSnapshot().images.filter(image => image.status === "ready")).toHaveLength(1);
  });

  it("transfers only the accepted snapshot and resets ordinal only at an empty new draft", async () => {
    const { draft, uploads, cancel } = setup();
    draft.add([file()]); await tick(); uploads[0].resolve(attachment(1)); await tick();
    const frozen = draft.getSnapshot().images;
    draft.add([file("next.png")]); await tick(); draft.accept(frozen);
    expect(draft.getSnapshot().images).toHaveLength(1);
    expect(draft.getSnapshot().images[0].ordinal).toBe(2);
    uploads[1].resolve(attachment(2)); await tick(); draft.accept(draft.getSnapshot().images);
    expect(draft.add([file("new.png")])[0].ordinal).toBe(1);
    draft.dispose(); expect(cancel).not.toHaveBeenCalled();
  });

  it("does not clear a re-uploaded image when an older frozen send is accepted", async () => {
    const { draft, uploads } = setup();
    const [one] = draft.add([file()]); await tick(); uploads[0].resolve(attachment(1)); await tick();
    const frozen = draft.getSnapshot().images;
    draft.remove(one.localClientId); draft.undo(); await tick();
    uploads[1].resolve(attachment(2)); await tick(); draft.accept(frozen);
    expect(draft.getSnapshot().images[0].attachment?.assetId).toBe(attachment(2).assetId);
  });

  it("rejects oversized originals before decoding, and caps the selection at four", async () => {
    const { draft, prepare } = setup();
    const huge = file(); Object.defineProperty(huge, "size", { value: IMAGE_INPUT_MAX_BYTES + 1 });
    draft.add([huge]); await tick();
    expect(prepare).not.toHaveBeenCalled();
    expect(draft.getSnapshot().images[0].error).toBe("original-too-large");
    expect(draft.add([file(), file(), file(), file()])).toHaveLength(3);
    expect(draft.getSnapshot().limitReached).toBe(true);
  });

  it("keeps a newer removal undo and its ordinal when the frozen send is accepted", async () => {
    const { draft, uploads } = setup();
    draft.add([file()]); await tick(); uploads[0].resolve(attachment(1)); await tick();
    const frozen = draft.getSnapshot().images;
    const [next] = draft.add([file("next.png")]); await tick();
    draft.remove(next.localClientId); draft.accept(frozen);
    expect(draft.getSnapshot().removed?.ordinal).toBe(2);
    expect(draft.add([file("third.png")])[0].ordinal).toBe(3);
    draft.undo();
    expect(draft.getSnapshot().images.map(image => image.ordinal)).toEqual([2, 3]);
  });

  it("retains identity after upload failure and retries without assigning another ordinal", async () => {
    const { draft, uploads } = setup();
    const [one] = draft.add([file()]); await tick(); uploads[0].reject(new Error("offline")); await tick();
    expect(draft.getSnapshot().images[0]).toMatchObject({ status: "error", error: "offline" });
    draft.retry(one.localClientId); await tick(); uploads[1].resolve(attachment(1)); await tick();
    expect(draft.getSnapshot().images[0]).toMatchObject({ localClientId: one.localClientId, ordinal: 1, status: "ready" });
  });
});
