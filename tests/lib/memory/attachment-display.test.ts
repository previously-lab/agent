/**
 * The shelf's attachment display model (v0.19 §C.1) — the pure half of the
 * rendering: image/file partitioning, URL building, and the empty case.
 * (JSX rendering itself has no test runtime in this repo — node environment,
 * no component libs, deps frozen — so the logic worth pinning lives here.)
 */
import { describe, it, expect } from "vitest";
import {
  buildAttachmentDisplay,
  attachmentUrl,
} from "@/components/memory/attachment-display";

const CASE = { category: "research", name: "手机调研" };

describe("buildAttachmentDisplay", () => {
  it("有图： images partition out and get /api/attachments URLs", () => {
    const model = buildAttachmentDisplay({
      ...CASE,
      attachments: [
        { name: "2026-09-05-photo.jpg", image: true },
        { name: "2026-09-06-数据.txt", image: false },
        { name: "2026-09-07-截图.png", image: true },
      ],
    });
    expect(model).not.toBeNull();
    expect(model!.images.map((i) => i.name)).toEqual([
      "2026-09-05-photo.jpg",
      "2026-09-07-截图.png",
    ]);
    expect(model!.files.map((f) => f.name)).toEqual(["2026-09-06-数据.txt"]);
    expect(model!.images[0].url).toBe(
      `/api/attachments?ref=${encodeURIComponent("research/手机调研/2026-09-05-photo.jpg")}`,
    );
  });

  it("无图: an all-file case renders files only, images empty", () => {
    const model = buildAttachmentDisplay({
      ...CASE,
      attachments: [{ name: "2026-09-05-notes.txt", image: false }],
    });
    expect(model!.images).toEqual([]);
    expect(model!.files).toHaveLength(1);
  });

  it("空： no attachments → null (the section does not render at all)", () => {
    expect(buildAttachmentDisplay({ ...CASE, attachments: [] })).toBeNull();
  });

  it("names sort ascending regardless of input order", () => {
    const model = buildAttachmentDisplay({
      ...CASE,
      attachments: [
        { name: "b.jpg", image: true },
        { name: "a.jpg", image: true },
      ],
    });
    expect(model!.images.map((i) => i.name)).toEqual(["a.jpg", "b.jpg"]);
  });
});

describe("attachmentUrl", () => {
  it("encodes the whole ref (slashes, CJK, spaces survive the round trip)", () => {
    const url = attachmentUrl("research", "手机 调研", "2026-09-05-截 图.jpg");
    expect(url.startsWith("/api/attachments?ref=")).toBe(true);
    const ref = new URL(`http://localhost${url}`).searchParams.get("ref");
    expect(ref).toBe("research/手机 调研/2026-09-05-截 图.jpg");
  });
});
