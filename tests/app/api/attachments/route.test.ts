/**
 * GET /api/attachments (v0.19 §C.1) — the rejection matrix and the happy
 * byte-serve. The fs layer is an in-memory local mock; STORAGE=local is set
 * before the module graph loads so io-helpers binds the local backend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: vi.fn(async () => {
    throw new Error("text read not used by the attachment route");
  }),
  readBinaryFileLocal: async (p: string) => {
    const hit = io.files.get(p);
    if (!hit) throw new Error(`File not found: "${p}"`);
    return hit;
  },
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
  writeBinaryFileLocal: vi.fn(async () => ({ path: "", created: true })),
  deleteFileLocal: vi.fn(async () => {}),
  listFilesLocal: vi.fn(async () => []),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  readFileFresh: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  invalidateReadCache: vi.fn(),
}));
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: vi.fn(async () => {
    throw new Error("demo read should not be called");
  }),
  listFilesDemo: vi.fn(async () => []),
  writeFileDemo: vi.fn(async () => ({ path: "", created: true })),
}));

import { GET } from "@/app/api/attachments/route";
void GET; // static import keeps tsc honest; the tests use the fresh binding below

type RouteModule = typeof import("@/app/api/attachments/route");
let route: RouteModule;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function requestFor(ref: string): Request {
  return new Request(`http://localhost/api/attachments?ref=${encodeURIComponent(ref)}`);
}

beforeEach(async () => {
  process.env.STORAGE = "local";
  vi.resetModules();
  route = await import("@/app/api/attachments/route");
  io.files.clear();
});

describe("GET /api/attachments — rejections (400/404, never 500)", () => {
  it("traversal in the case name → 400", async () => {
    const res = await route.GET(requestFor("research/../escape/x.jpg"));
    expect(res.status).toBe(400);
  });

  it("a separator inside the file name → 400", async () => {
    const res = await route.GET(requestFor("research/手机调研/sub/dir/x.jpg"));
    expect(res.status).toBe(400);
  });

  it("an absolute path attempt → 400", async () => {
    const res = await route.GET(requestFor("research/手机调研/C:\\win\\x.jpg"));
    expect(res.status).toBe(400);
  });

  it("an unknown category → 400", async () => {
    const res = await route.GET(requestFor("secrets/手机调研/x.jpg"));
    expect(res.status).toBe(400);
  });

  it("a 4-digit-leading case name (slice-id namespace) → 400", async () => {
    const res = await route.GET(requestFor("research/2026-09-05-1030/x.jpg"));
    expect(res.status).toBe(400);
  });

  it("a dead attachment → 404 with a visible message", async () => {
    const res = await route.GET(requestFor("research/手机调研/2026-09-05-不存在.jpg"));
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });
});

describe("GET /api/attachments — the happy path", () => {
  it("serves the exact bytes with the extension's Content-Type", async () => {
    io.files.set("memory/research/手机调研/attachments/2026-09-05-photo.jpg", JPEG);
    const res = await route.GET(requestFor("research/手机调研/2026-09-05-photo.jpg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Length")).toBe(String(JPEG.byteLength));
    const body = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(body, JPEG)).toBe(0);
  });

  it("URL-decodes the reference (the client sends it encoded)", async () => {
    io.files.set("memory/research/手机调研/attachments/2026-09-05-截图.png", JPEG);
    const res = await route.GET(requestFor("research/手机调研/2026-09-05-截图.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});
