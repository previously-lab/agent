/**
 * Attachments (v0.19 §C.1) — binary write path, naming, fuses, the three
 * identities, and the viewImage doc: source.
 *
 * REAL local backend (temp cwd + STORAGE=local): bytes hit the actual disk
 * through writeBinaryFileLocal / the batch flush's base64 path, so the
 * round-trip assertions are byte-level, not mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// A real (tiny) JPEG — 1x1 pixel, base64-constant.
const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////wgARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEA" +
  "AhEDEQA/AA8AD//2Q==";
const JPEG_BYTES = Buffer.from(JPEG_B64, "base64");

const vision = vi.hoisted(() => ({ describeImage: vi.fn() }));
vi.mock("@/lib/vision/describe-image", () => ({ describeImage: vision.describeImage }));
vi.mock("workflow", () => ({
  getWritable: () => ({
    getWriter: () => ({ write: vi.fn(async () => {}), releaseLock: vi.fn() }),
  }),
}));

// The backend choice is captured at module load — import FRESH after the
// temp-dir env is set (same pattern as tests/lib/evolution/store.test.ts).
async function fresh() {
  const attachments = await import("@/lib/tools/attachments");
  const io = await import("@/lib/episodic/io-helpers");
  const executors = await import("@/app/api/agent/tool-executors");
  return { ...attachments, ...io, viewImageExecute: executors.viewImageExecute };
}

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-attachments-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  process.env.STORAGE = "local";
  process.chdir(tmpDir);
  vi.resetModules();
  vision.describeImage.mockReset();
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) process.env.STORAGE = origStorage;
  else delete process.env.STORAGE;
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bytesOnDisk(relPath: string): Buffer {
  return fs.readFileSync(path.join(tmpDir, relPath));
}

describe("naming (§C.1)", () => {
  it("purifies unsafe characters (naming.ts's shared unsafe-chars discipline)", async () => {
    const { sanitizeAttachmentName } = await fresh();
    expect(sanitizeAttachmentName("a/b\\c:d.jpg")).toBe("a-b-c-d.jpg");
    expect(sanitizeAttachmentName("  spaced  ")).toBe("spaced");
    expect(sanitizeAttachmentName("..dots..")).toBe("dots");
    expect(sanitizeAttachmentName("")).toBe("attachment");
    expect(sanitizeAttachmentName("正常 名字.png")).toBe("正常 名字.png");
  });

  it("agrees with naming.ts: same purifier, and the output passes its validator", async () => {
    const { sanitizeAttachmentName } = await fresh();
    const { sanitizeNameComponent, hasUnsafeChars } = await import(
      "@/lib/docs/naming"
    );
    const corpus = [
      "a/b\\c:d.jpg",
      "  spaced  ",
      "..dots..",
      "",
      "正常 名字.png",
      "con<trol>chars.png",
      "???***",
      "...",
      "a--b---c.pdf",
      "ｆｕｌｌｗｉｄｔｈ.png",
      "trail. ",
      "NUL\0byte.txt",
    ];
    for (const raw of corpus) {
      const out = sanitizeAttachmentName(raw);
      // One shared purifier — the wrapper only owns the empty fallback.
      expect(out).toBe(sanitizeNameComponent(raw) || "attachment");
      // The purified name passes the docs module's own unsafe-chars check.
      expect(hasUnsafeChars(out)).toBe(false);
    }
  });

  it("case attachments are <yyyy-mm-dd>-<name>; records are <turnId>-<name>", async () => {
    const { caseAttachmentName, recordAttachmentName } = await fresh();
    expect(caseAttachmentName("2026-09-05", "photo.jpg")).toBe("2026-09-05-photo.jpg");
    expect(recordAttachmentName("t1x2yz", "photo.jpg")).toBe("t1x2yz-photo.jpg");
  });

  it("the turnId prefix makes cross-turn collisions structurally impossible", async () => {
    const { recordAttachmentName } = await fresh();
    const a = recordAttachmentName("turn-A", "same.jpg");
    const b = recordAttachmentName("turn-B", "same.jpg");
    expect(a).not.toBe(b);
    expect(a.startsWith("turn-A-")).toBe(true);
    expect(b.startsWith("turn-B-")).toBe(true);
  });
});

describe("binary write path — byte-identical end to end", () => {
  it("a real jpeg via the records evidence slot reads back byte-for-byte", async () => {
    const { persistEvidenceAttachments } = await fresh();
    const result = await persistEvidenceAttachments({
      sliceId: "2026-09-05-1030",
      turnId: "t9f2ha",
      files: [{ name: "photo.jpg", data: JPEG_BYTES }],
    });
    expect(result.saved).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(result.saved[0].name).toBe("t9f2ha-photo.jpg");
    const written = bytesOnDisk(result.saved[0].path);
    expect(Buffer.compare(written, JPEG_BYTES)).toBe(0);
  });

  it("batched binary rides the batch flush base64 and lands byte-identical", async () => {
    const { createBatch, flushBatch, fsWriteBinaryFile } = await fresh();
    const batch = createBatch();
    await fsWriteBinaryFile("memory/research/手机调研/attachments/2026-09-05-photo.jpg", JPEG_BYTES, batch);
    await flushBatch(batch, "test batch");
    const written = bytesOnDisk("memory/research/手机调研/attachments/2026-09-05-photo.jpg");
    expect(Buffer.compare(written, JPEG_BYTES)).toBe(0);
  });

  it("a same-name same-turn repeat gets a deterministic -2 suffix (born, never overwritten)", async () => {
    const { persistEvidenceAttachments } = await fresh();
    const result = await persistEvidenceAttachments({
      sliceId: "2026-09-05-1030",
      turnId: "t9f2ha",
      files: [
        { name: "photo.jpg", data: JPEG_BYTES },
        { name: "photo.jpg", data: JPEG_BYTES },
      ],
    });
    expect(result.saved.map((s) => s.name)).toEqual([
      "t9f2ha-photo.jpg",
      "t9f2ha-photo-2.jpg",
    ]);
  });
});

describe("fuses — visible errors, never truncated", () => {
  it("a single file over 5MB is refused with a visible reason, nothing written", async () => {
    const { persistEvidenceAttachments, MAX_ATTACHMENT_BYTES } = await fresh();
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    const result = await persistEvidenceAttachments({
      sliceId: "2026-09-05-1030",
      turnId: "t9f2ha",
      files: [{ name: "big.bin", data: big }],
    });
    expect(result.saved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("5MB");
    expect(result.skipped[0].reason).toContain("未保存");
    const dir = path.join(tmpDir, "memory/records/2026/09/05/1030/attachments");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("a case whose attachments would exceed 25MB total refuses the new file, keeps the old", async () => {
    const { persistEvidenceAttachments } = await fresh();
    // Seed exactly 25MiB total (5 × exactly-5MiB files — the single-file
    // check is `>`, so each passes), then even a tiny file trips the
    // per-case fuse: refused, visible.
    const chunk = Buffer.alloc(5 * 1024 * 1024);
    const first = await persistEvidenceAttachments({
      sliceId: "2026-09-05-1030",
      turnId: "seed00",
      files: Array.from({ length: 5 }, (_, i) => ({ name: `part-${i}.bin`, data: chunk })),
    });
    expect(first.saved).toHaveLength(5);
    const second = await persistEvidenceAttachments({
      sliceId: "2026-09-05-1030",
      turnId: "seed00",
      files: [{ name: "one-more.jpg", data: JPEG_BYTES }],
    });
    expect(second.saved).toEqual([]);
    expect(second.skipped[0].reason).toContain("25MB");
    expect(second.skipped[0].reason).toContain("未保存");
    // The existing attachments are untouched — no truncation, no overwrite.
    expect(bytesOnDisk(first.saved[0].path).byteLength).toBe(chunk.byteLength);
  });
});

describe("identity 3: assets are copied INTO the document case", () => {
  it("copyAssetAttachment duplicates bytes into the case attachments", async () => {
    const { copyAssetAttachment, fsWriteBinaryFile } = await fresh();
    await fsWriteBinaryFile("memory/records/2026/09/05/1030/attachments/t1-photo.jpg", JPEG_BYTES);
    const out = await copyAssetAttachment({
      category: "research",
      caseName: "手机调研",
      sourcePath: "memory/records/2026/09/05/1030/attachments/t1-photo.jpg",
      originalName: "photo.jpg",
      date: "2026-09-05",
    });
    expect(out.name).toBe("2026-09-05-photo.jpg");
    const copy = bytesOnDisk(out.path);
    expect(Buffer.compare(copy, JPEG_BYTES)).toBe(0);
    // the source is still there — a copy, not a move
    expect(fs.existsSync(path.join(tmpDir, "memory/records/2026/09/05/1030/attachments/t1-photo.jpg"))).toBe(true);
  });
});

describe("reading: the viewImage doc: source", () => {
  it("viewImage doc:<分类>/<case名>/<附件名> hands the exact bytes to the vision model", async () => {
    const { viewImageExecute, fsWriteBinaryFile, dataUrlToBuffer } = await fresh();
    await fsWriteBinaryFile("memory/research/手机调研/attachments/2026-09-05-photo.jpg", JPEG_BYTES);
    vision.describeImage.mockResolvedValue({
      ok: true,
      description: "a photo",
      metadata: { width: 1, height: 1, bytes: JPEG_BYTES.byteLength, format: "jpeg" },
      degraded: false,
    });
    const out = await viewImageExecute(
      { source: "doc:research/手机调研/2026-09-05-photo.jpg" },
      { context: {
          repo: "local", owner: "local", useGithub: false, useDemo: false,
          sliceId: "2026-09-05-1030", recentTurns: [],
        }, toolCallId: "tc1" },
    );
    expect(out).toContain("a photo");
    const input = vision.describeImage.mock.calls[0][0] as {
      image: { data: string; mediaType: string };
    };
    expect(input.image.mediaType).toBe("image/jpeg");
    const decoded = dataUrlToBuffer(input.image.data);
    expect(decoded).not.toBeNull();
    expect(Buffer.compare(decoded!.data, JPEG_BYTES)).toBe(0);
  });

  it("a dead doc attachment name is a visible error, never a throw", async () => {
    const { viewImageExecute } = await fresh();
    const out = await viewImageExecute(
      { source: "doc:research/不存在/x.jpg" },
      { context: {
          repo: "local", owner: "local", useGithub: false, useDemo: false,
          sliceId: "2026-09-05-1030", recentTurns: [],
        }, toolCallId: "tc1" },
    );
    expect(out).toMatch(/^ERROR:/);
  });

  it("readCaseAttachment refuses a traversal name at the read surface", async () => {
    const { readCaseAttachment } = await fresh();
    await expect(
      readCaseAttachment({ category: "research", caseName: "手机调研", fileName: "../escape.jpg" }),
    ).rejects.toThrow(/illegal attachment name/);
  });

  it("caseAttachmentsDir / recordAttachmentsDir land where §B.1/§B.5 put them", async () => {
    const { caseAttachmentsDir, recordAttachmentsDir, recordAttachmentName } = await fresh();
    expect(caseAttachmentsDir("research", "手机调研")).toBe("memory/research/手机调研/attachments");
    expect(recordAttachmentsDir("2026-09-05-1030")).toBe("memory/records/2026/09/05/1030/attachments");
    expect(recordAttachmentName("t1", "a.jpg")).toMatch(/^t1-/);
  });
});

