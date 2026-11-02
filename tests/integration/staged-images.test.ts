import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "staged-images-"));
  vi.stubEnv("STORAGE", "local"); vi.stubEnv("MEMORY_ROOT", path.join(root, "memory")); vi.stubEnv("SESSIONS_ROOT", path.join(root, "sessions"));
  vi.stubGlobal("fetch", () => { throw new Error("No network in image fixtures"); });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(root.startsWith(path.join(os.tmpdir(), "staged-images-"))).toBe(true);
  fs.rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const service = await import("@/lib/tools/staged-images");
  const image = await service.stageImage({ data: PNG, name: "fictional.png", persona: "user" });
  return { ...service, image };
}
function manifest(assetId: string): { file: string; value: Record<string, unknown> } {
  const base = path.join(root, "sessions/attachment-drafts");
  for (const scope of fs.readdirSync(base)) {
    const file = path.join(base, scope, `${assetId}.json`);
    if (fs.existsSync(file)) return { file, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  }
  throw new Error("Fixture manifest missing");
}
describe("real isolated image staging", () => {
  it("multipart route sniffs real content, preview is no-store, and repeated cancel returns 204", async () => {
    const upload = await import("@/app/api/attachments/upload/route");
    const read = await import("@/app/api/attachments/route");
    const cancel = await import("@/app/api/attachments/upload/[assetId]/cancel/route");
    const form = new FormData(); form.set("file", new File([PNG], "fake.jpg", { type: "image/jpeg" })); form.set("persona", "user");
    const response = await upload.POST(new Request("http://localhost/api/attachments/upload", { method: "POST", headers: { origin: "http://localhost", host: "localhost" }, body: form }));
    expect(response.status).toBe(201);
    const { attachment } = await response.json(); expect(attachment.mediaType).toBe("image/png"); expect(attachment.ordinal).toBeUndefined();
    const preview = await read.GET(new Request(`http://localhost/api/attachments?ref=${attachment.ref}`));
    expect(preview.headers.get("cache-control")).toBe("no-store"); expect(Buffer.from(await preview.arrayBuffer())).toEqual(PNG);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cancel.POST(new Request("http://localhost/api/attachments/upload/id/cancel?persona=user", { method: "POST", headers: { origin: "http://localhost", host: "localhost" } }), { params: Promise.resolve({ assetId: attachment.assetId }) });
      expect(result.status).toBe(204);
    }
  });
  it("upload is not memory; preview reads exact bytes; cancel is idempotent", async () => {
    const { image, readStagedImage, cancelStagedImage } = await setup();
    expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
    expect((await readStagedImage(image.assetId)).data).toEqual(PNG);
    await cancelStagedImage(image.assetId); await cancelStagedImage(image.assetId);
    await expect(readStagedImage(image.assetId)).rejects.toMatchObject({ code: "asset_cancelled" });
  });
  it("scope switches cannot read, reserve or cancel another source's image", async () => {
    const { image, readStagedImage, reserveStagedImages, cancelStagedImage } = await setup();
    await expect(readStagedImage(image.assetId, "other")).rejects.toMatchObject({ code: "invalid_persona" });
    vi.stubEnv("MEMORY_ROOT", path.join(root, "other-memory"));
    await expect(readStagedImage(image.assetId)).rejects.toMatchObject({ code: "asset_missing" });
    await expect(cancelStagedImage(image.assetId)).rejects.toMatchObject({ code: "asset_missing" });
    await expect(reserveStagedImages([{ assetId: image.assetId, ordinal: 2 }], "m")).rejects.toMatchObject({ code: "asset_missing" });
    vi.stubEnv("STORAGE", "demo");
    await expect(readStagedImage(image.assetId)).rejects.toMatchObject({ code: "read_only" });
  });
  it("reservation rollback lets an unchanged draft retry with another message ID", async () => {
    const { image, reserveStagedImages, cancelStagedImage } = await setup();
    const refs = [{ assetId: image.assetId, ordinal: 2 }];
    const attempt = await reserveStagedImages(refs, "first");
    await expect(cancelStagedImage(image.assetId)).rejects.toMatchObject({ code: "asset_claimed" });
    await attempt.release();
    expect(manifest(image.assetId).value.state).toBe("staged");
    const retry = await reserveStagedImages(refs, "second"); await retry.confirm();
    await attempt.release(); // stale rollback cannot undo the newer acceptance
    expect(manifest(image.assetId).value.state).toBe("claimed");
    await expect(cancelStagedImage(image.assetId)).rejects.toMatchObject({ code: "asset_claimed" });
    expect((await reserveStagedImages(refs, "second")).attachments[0].snapshot.ordinal).toBe(2);
    await expect(reserveStagedImages(refs, "third")).rejects.toMatchObject({ code: "asset_claimed" });
  });
  it("a competing cancellation of the second image rolls back only this attempt's first reservation", async () => {
    const service = await setup();
    const second = await service.stageImage({ data: PNG, name: "second.png" });
    const io = await import("@/lib/episodic/io-helpers"); const write = io.fsWriteFile;
    let raced = false;
    vi.spyOn(io, "fsWriteFile").mockImplementation(async (file, content, batch) => {
      if (!raced && file.includes(`${service.image.assetId}.json.`) && JSON.parse(content).state === "reserved") {
        raced = true; await service.cancelStagedImage(second.assetId);
      }
      return write(file, content, batch);
    });
    await expect(service.reserveStagedImages([{ assetId: service.image.assetId, ordinal: 1 }, { assetId: second.assetId, ordinal: 2 }], "race")).rejects.toMatchObject({ code: "asset_cancelled" });
    expect(manifest(service.image.assetId).value.state).toBe("staged");
    expect(manifest(second.assetId).value.state).toBe("cancelled");
    await (await service.reserveStagedImages([{ assetId: service.image.assetId, ordinal: 1 }], "retry")).confirm();
    expect(manifest(service.image.assetId).value.state).toBe("claimed");
  });
  it("failed manifest replacement preserves the old complete state and can retry", async () => {
    const service = await setup();
    const io = await import("@/lib/episodic/io-helpers"); const write = io.fsWriteFile;
    const spy = vi.spyOn(io, "fsWriteFile").mockImplementation(async (file, content, batch) => {
      if (JSON.parse(content).state === "reserved") {
        await write(file, "{partial", batch);
        throw new Error("fixture interrupted write");
      }
      return write(file, content, batch);
    });
    await expect(service.reserveStagedImages([{ assetId: service.image.assetId, ordinal: 2 }], "failed")).rejects.toThrow("fixture interrupted write");
    expect(manifest(service.image.assetId).value.state).toBe("staged");
    expect((await service.readStagedImage(service.image.assetId)).data).toEqual(PNG);
    spy.mockRestore();
    await (await service.reserveStagedImages([{ assetId: service.image.assetId, ordinal: 2 }], "retry")).confirm();
    expect(manifest(service.image.assetId).value.state).toBe("claimed");
  });
  it("concurrent claims have a single owner and losing release cannot erase it", async () => {
    const { image, reserveStagedImages } = await setup();
    const attempts = await Promise.allSettled(["one", "two"].map((id) => reserveStagedImages([{ assetId: image.assetId, ordinal: 1 }], id)));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveStagedImages>>>;
    await winner.value.confirm(); expect(manifest(image.assetId).value.state).toBe("claimed");
  });
  it("expired unsent drafts are swept while accepted images remain protected", async () => {
    const service = await setup();
    const accepted = await service.stageImage({ data: PNG, name: "accepted.png" });
    await (await service.reserveStagedImages([{ assetId: accepted.assetId, ordinal: 1 }], "accepted")).confirm();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + service.IMAGE_DRAFT_TTL_MS + 1);
    expect(await service.sweepStagedImages()).toBe(1);
    await expect(service.readStagedImage(service.image.assetId)).rejects.toMatchObject({ code: "asset_missing" });
    expect((await service.readStagedImage(accepted.assetId)).data).toEqual(PNG);
  });
  it("persistent images reuse their record path after retry, keep ordinal and retire staging bytes", async () => {
    const service = await setup();
    const reservation = await service.reserveStagedImages([{ assetId: service.image.assetId, ordinal: 2 }], "persist"); await reservation.confirm();
    const io = await import("@/lib/episodic/io-helpers");
    const { persistImageAttachments, readRecordImage } = await import("@/lib/tools/attachments");
    const batch = io.createBatch();
    const snapshots = await persistImageAttachments({ sliceId: "2026-11-02-0800", turnId: "turn01", images: reservation.attachments, batch });
    await io.flushBatch(batch, "Fixture image");
    const again = await persistImageAttachments({ sliceId: "2026-11-02-0800", turnId: "turn01", images: reservation.attachments, batch: io.createBatch() });
    expect(again).toEqual(snapshots); expect(snapshots[0].ordinal).toBe(2);
    expect((await readRecordImage(snapshots[0].ref)).data).toEqual(PNG);
    expect(fs.readdirSync(path.join(root, "memory/records/2026/11/02/0800/attachments"))).toHaveLength(1);
    await service.settleStagedImages(snapshots);
    expect(fs.existsSync(manifest(service.image.assetId).file.replace(/\.json$/, ".bin"))).toBe(false);
    expect((await service.readStagedImage(service.image.assetId)).data).toEqual(PNG);
  });
  it("rejects truncated, disguised and oversized content before writing drafts", async () => {
    const { stageImage } = await import("@/lib/tools/staged-images");
    for (const data of [PNG.subarray(0, 33), Buffer.from('<svg onload="bad()"/>'), Buffer.alloc(5 * 1024 * 1024 + 1)]) {
      await expect(stageImage({ data, name: "pretend.png" })).rejects.toBeInstanceOf(Error);
    }
    const oversized = Buffer.from(PNG); oversized.writeUInt32BE(50_000, 16);
    await expect(stageImage({ data: oversized, name: "large.png" })).rejects.toMatchObject({ code: "image_format" });
    expect(fs.existsSync(path.join(root, "sessions"))).toBe(false);
  });
});
