import { describe, expect, it } from "vitest";
import { encodeImageAttachments, decodeImageAttachments, parseStagedAttachments, parseRecordImageRef, recordImageRef } from "@/lib/chat/image-attachments";
const id = `img_${"a".repeat(32)}`;
describe("image identities and stable ordinals", () => {
  it("keeps ordinal gaps and round-trips structured record snapshots", () => {
    expect(parseStagedAttachments([{ assetId: id, ordinal: 2 }])).toEqual([{ assetId: id, ordinal: 2 }]);
    const image = { version: 1 as const, assetId: id, ordinal: 2, ref: recordImageRef("2026-11-02-0800", "t-image.png"), name: "画面.png", mediaType: "image/png", byteSize: 68 };
    expect(decodeImageAttachments(encodeImageAttachments([image]))).toEqual([image]);
  });
  it.each([0, -1, 1.5, 1_000_001, "2", null])("rejects invalid display ordinal %s", (ordinal) => {
    expect(() => parseStagedAttachments([{ assetId: id, ordinal }])).toThrow();
  });
  it("rejects duplicate IDs, duplicate ordinals, too many and path-shaped IDs", () => {
    expect(() => parseStagedAttachments([{ assetId: id, ordinal: 1 }, { assetId: id, ordinal: 2 }])).toThrow();
    expect(() => parseStagedAttachments([{ assetId: id, ordinal: 1 }, { assetId: `img_${"b".repeat(32)}`, ordinal: 1 }])).toThrow();
    expect(() => parseStagedAttachments(Array.from({ length: 5 }, (_, i) => ({ assetId: `img_${String(i).repeat(32)}`, ordinal: i + 1 })))).toThrow();
    expect(() => parseStagedAttachments([{ assetId: "../memory/core.md", ordinal: 1 }])).toThrow();
  });
  it.each(["records/2026/02/30/0800/photo.png", "records/2026/11/02/2500/photo.png", "records/2026/11/02/0800/../core.md", "records/2026/11/02/0800/C:secret.png"])("rejects invalid record ref %s", (ref) => {
    expect(parseRecordImageRef(ref)).toBeNull();
  });
  it("malformed or draft metadata never becomes archived image evidence", () => {
    expect(decodeImageAttachments("broken")).toEqual([]);
    expect(decodeImageAttachments(encodeImageAttachments([{ version: 1, assetId: id, ref: `drafts/${id}`, name: "image.png", mediaType: "image/png" }]))).toEqual([]);
  });
});
