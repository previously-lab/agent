import { expect, it, vi } from "vitest";
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/app/api/chat/turn-workflow", () => ({ turnWorkflow: vi.fn() }));
import { extractImageAttachments } from "@/app/api/chat/start-turn";
import { withVerifiedImages, legacyMessageImages } from "@/lib/tools/chat-image-input";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
it("ordinal 2 maps to tool attachment:0 after image 1 is deleted", () => {
  const image = { snapshot: { version: 1 as const, assetId: `img_${"a".repeat(32)}`, ordinal: 2, ref: "unused", name: "second.png", mediaType: "image/png" }, dataBase64: png };
  const messages = withVerifiedImages([{ id: "m", role: "user", parts: [{ type: "text", text: "Compare 〔图2〕" }] }], [image]);
  const result = extractImageAttachments(messages, "zh");
  expect(result.attachments).toEqual([`data:image/png;base64,${png}`]);
  expect(JSON.stringify(result.messages)).toContain("〔图2〕 = second.png");
  expect(JSON.stringify(result.messages)).toContain("attachment:0");
  expect(JSON.stringify(result.messages)).not.toContain("〔图1〕");
});
it("legacy data URLs are validated locally and external URLs cannot become model fetches", () => {
  const message = { id: "m", role: "user" as const, parts: [{ type: "file" as const, mediaType: "image/png", url: `data:image/png;base64,${png}`, filename: "old.png" }] };
  expect(legacyMessageImages([message])[0].snapshot.byteSize).toBe(Buffer.from(png, "base64").length);
  expect(() => legacyMessageImages([{ ...message, parts: [{ ...message.parts[0], url: "https://fixture.invalid/secret" }] }])).toThrow();
  expect(JSON.stringify(withVerifiedImages([{ ...message, parts: [{ ...message.parts[0], url: "file:///secret" }] }, { id: "new", role: "user", parts: [] }], []))).not.toContain("file:///secret");
});
it("two identical legacy images retain distinct stable identities and ordinals", () => {
  const part = { type: "file" as const, mediaType: "image/png", url: `data:image/png;base64,${png}`, filename: "same.png" };
  const images = legacyMessageImages([{ id: "m", role: "user", parts: [part, part] }]);
  expect(new Set(images.map((image) => image.snapshot.assetId)).size).toBe(2);
  expect(images.map((image) => image.snapshot.ordinal)).toEqual([1, 2]);
  expect(legacyMessageImages([{ id: "m", role: "user", parts: [part, part] }])).toEqual(images);
});
