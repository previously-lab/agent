import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DescribeImageResult } from "@/lib/vision/describe-image";
import type { ImageMetadata } from "@/lib/vision/image-meta";

const aiSdk = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", () => ({
  generateText: aiSdk.generateText,
}));

const registry = vi.hoisted(() => ({ getModel: vi.fn() }));
vi.mock("@/lib/models/registry", () => ({
  getModel: registry.getModel,
  ALL_MODELS: [],
}));

const provider = vi.hoisted(() => ({ createModel: vi.fn() }));
vi.mock("@/lib/models/provider", () => ({
  createModel: provider.createModel,
}));

const fetchUtils = vi.hoisted(() => ({
  fetchWithGuard: vi.fn(),
  isPrivateHost: vi.fn(() => false),
}));
vi.mock("@/lib/search/fetch-utils", () => ({
  fetchWithGuard: fetchUtils.fetchWithGuard,
  isPrivateHost: fetchUtils.isPrivateHost,
}));

import { describeImage } from "@/lib/vision/describe-image";

const SAVED_ENV = { ...process.env };

function assertError(r: DescribeImageResult): asserts r is { ok: false; error: string } {
  expect(r.ok).toBe(false);
}

function assertOk(
  r: DescribeImageResult,
): asserts r is {
  ok: true;
  description: string;
  metadata: ImageMetadata;
  degraded: boolean;
} {
  expect(r.ok).toBe(true);
}

/** Minimal legal PNG header (33-byte IHDR) for metadata assertions. */
function makePngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  return b;
}

function pngDataUrl(width: number, height: number): string {
  return `data:image/png;base64,${makePngBytes(width, height).toString("base64")}`;
}

function makeImageResponse(
  contentType = "image/png",
  body: Uint8Array = new Uint8Array(makePngBytes(640, 480)),
): Response {
  return new Response(body as unknown as BodyInit, {
    headers: { "content-type": contentType },
    status: 200,
    statusText: "OK",
  });
}

describe("describeImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...SAVED_ENV, DEEPSEEK_API_KEY: "test-key" };
    registry.getModel.mockReturnValue({
      id: "deepseek-v4-flash-vision-exp",
      sdk: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com",
      capabilities: { vision: true, thinking: true, maxTokens: 393216 },
      defaultThinking: true,
      defaultEffort: "low",
    });
    provider.createModel.mockReturnValue({ __kind: "languageModel" });
  });

  afterEach(() => {
    process.env = { ...SAVED_ENV };
  });

  it("degrades to metadata only when DEEPSEEK_API_KEY is missing", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const result = await describeImage({
      image: { data: pngDataUrl(800, 600), mediaType: "image/png" },
      question: "What is this?",
    });
    assertOk(result);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain("DEEPSEEK_API_KEY");
    expect(result.description).toContain("DEGRADED");
    expect(result.description).toContain("800×600 PNG");
    expect(result.description).toContain("What is this?");
    expect(result.metadata).toEqual({
      format: "png",
      width: 800,
      height: 600,
      bytes: 33,
    });
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("rejects non-image content types from URLs", async () => {
    fetchUtils.fetchWithGuard.mockResolvedValue(
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
        status: 200,
      }),
    );

    const result = await describeImage({ image: { url: "https://example.com/x" } });
    assertError(result);
    expect(result.error).toContain("non-image content type");
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("returns an error when fetching the image fails", async () => {
    fetchUtils.fetchWithGuard.mockRejectedValue(new Error("network down"));

    const result = await describeImage({ image: { url: "https://example.com/x.png" } });
    assertError(result);
    expect(result.error).toContain("Could not fetch image");
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("describes an image from a URL with a question and attaches metadata", async () => {
    fetchUtils.fetchWithGuard.mockResolvedValue(makeImageResponse());
    aiSdk.generateText.mockResolvedValue({ text: "A red circle." });

    const result = await describeImage({
      image: { url: "https://example.com/circle.png" },
      question: "What color is it?",
      locale: "en",
    });

    assertOk(result);
    expect(result.degraded).toBe(false);
    expect(result.description).toBe("A red circle.");
    expect(result.metadata.format).toBe("png");
    expect(result.metadata.width).toBe(640);
    expect(result.metadata.height).toBe(480);
    expect(aiSdk.generateText).toHaveBeenCalledTimes(1);
    const args = aiSdk.generateText.mock.calls[0]![0];
    expect(args.model).toEqual({ __kind: "languageModel" });
    expect(args.messages[0].content).toHaveLength(2);
    expect(args.messages[0].content[1].text).toContain("What color is it?");
  });

  it("describes an image from base64 data and attaches metadata", async () => {
    aiSdk.generateText.mockResolvedValue({ text: "A cat." });
    const b64 = Buffer.from(makePngBytes(100, 50)).toString("base64");

    const result = await describeImage({
      image: { data: b64, mediaType: "image/png" },
      locale: "zh",
    });

    assertOk(result);
    expect(result.degraded).toBe(false);
    expect(result.description).toBe("A cat.");
    expect(result.metadata.width).toBe(100);
    expect(result.metadata.height).toBe(50);
    expect(aiSdk.generateText).toHaveBeenCalledTimes(1);
    const args = aiSdk.generateText.mock.calls[0]![0];
    expect(args.messages[0].content[0].image).toBe(b64);
    expect(args.messages[0].content[0].mimeType).toBe("image/png");
    expect(args.messages[0].content[1].text).toContain("用中文回答");
  });

  it("accepts a data URL as image data", async () => {
    aiSdk.generateText.mockResolvedValue({ text: "A dog." });

    const result = await describeImage({
      image: { data: "data:image/jpeg;base64,xx", mediaType: "image/jpeg" },
    });

    assertOk(result);
    expect(result.description).toBe("A dog.");
    const args = aiSdk.generateText.mock.calls[0]![0];
    expect(args.messages[0].content[0].image).toBe("data:image/jpeg;base64,xx");
    expect(args.messages[0].content[0]).not.toHaveProperty("mimeType");
  });

  it("degrades to metadata only when the vision model is missing from the registry", async () => {
    registry.getModel.mockReturnValue(undefined);

    const result = await describeImage({
      image: { data: pngDataUrl(320, 200), mediaType: "image/png" },
    });

    assertOk(result);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain("deepseek-v4-flash-vision-exp");
    expect(result.description).toContain("DEGRADED");
    expect(result.metadata.width).toBe(320);
    expect(aiSdk.generateText).not.toHaveBeenCalled();
  });

  it("degrades to metadata only when the vision call fails", async () => {
    aiSdk.generateText.mockRejectedValue(new Error("rate limited"));

    const result = await describeImage({
      image: { data: pngDataUrl(10, 10), mediaType: "image/png" },
    });

    assertOk(result);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain("rate limited");
    expect(result.description).toContain("DEGRADED");
    expect(result.description).toContain("rate limited");
  });
});
