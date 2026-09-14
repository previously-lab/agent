import { describe, it, expect } from "vitest";
import {
  decodeDataUrl,
  formatBytes,
  formatImageMetadata,
  parseImageMetadata,
} from "@/lib/vision/image-meta";

/** Minimal legal file headers, constructed in code. */

function makePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR length
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; // bit depth
  return b;
}

function makeGif(width: number, height: number, version: "7a" | "9a" = "9a"): Buffer {
  const b = Buffer.alloc(32);
  b.write(`GIF8${version}`, 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function makeJpeg(
  width: number,
  height: number,
  sofMarker = 0xc0,
  withApp0 = false,
): Buffer {
  const parts: number[] = [0xff, 0xd8];
  if (withApp0) {
    parts.push(0xff, 0xe0, 0x00, 0x10);
    for (let i = 0; i < 14; i++) parts.push(0x4a); // JFIF\0... padding
  }
  parts.push(0xff, sofMarker, 0x00, 0x11, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  parts.push(0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  return Buffer.from(parts);
}

function makeWebpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(20, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); // chunk length
  // VP8X stores width/height minus 1 as 24-bit LE.
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function makeWebpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(20, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a; // VP8 frame tag start
  b.writeUInt16LE(width & 0x3fff, 26);
  b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

function makeWebpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(21, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt32LE(5, 16);
  b[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

describe("parseImageMetadata", () => {
  it("parses PNG dimensions from the IHDR chunk", () => {
    const meta = parseImageMetadata(new Uint8Array(makePng(800, 600)));
    expect(meta).toEqual({
      format: "png",
      width: 800,
      height: 600,
      bytes: 33,
    });
  });

  it("parses GIF87a and GIF89a dimensions", () => {
    for (const v of ["7a", "9a"] as const) {
      const meta = parseImageMetadata(
        new Uint8Array(makeGif(640, 480, v)),
      );
      expect(meta.format).toBe("gif");
      expect(meta.width).toBe(640);
      expect(meta.height).toBe(480);
    }
  });

  it("parses JPEG SOF0 dimensions", () => {
    const meta = parseImageMetadata(new Uint8Array(makeJpeg(1920, 1080)));
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it("parses JPEG dimensions after APP0/JFIF segments", () => {
    const meta = parseImageMetadata(
      new Uint8Array(makeJpeg(320, 240, 0xc0, true)),
    );
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
  });

  it("parses JPEG progressive (SOF2) dimensions", () => {
    const meta = parseImageMetadata(new Uint8Array(makeJpeg(100, 50, 0xc2)));
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50);
  });

  it("parses WebP VP8X dimensions", () => {
    const meta = parseImageMetadata(new Uint8Array(makeWebpVp8x(1024, 768)));
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(768);
  });

  it("parses WebP lossy (VP8) dimensions", () => {
    const meta = parseImageMetadata(new Uint8Array(makeWebpVp8(640, 360)));
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
  });

  it("parses WebP lossless (VP8L) dimensions", () => {
    const meta = parseImageMetadata(new Uint8Array(makeWebpVp8l(512, 512)));
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it("reports unknown format and null dimensions for unrecognized bytes", () => {
    const meta = parseImageMetadata(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
    expect(meta.format).toBe("unknown");
    expect(meta.width).toBeNull();
    expect(meta.height).toBeNull();
    expect(meta.bytes).toBe(10);
  });

  it("falls back to the MIME hint when magic bytes are unrecognized", () => {
    const meta = parseImageMetadata(
      new Uint8Array([0, 0, 0, 0]),
      "image/gif",
    );
    expect(meta.format).toBe("gif");
    expect(meta.width).toBeNull();
  });

  it("keeps format but nulls impossible dimensions", () => {
    const meta = parseImageMetadata(new Uint8Array(makePng(0, 600)));
    expect(meta.format).toBe("png");
    expect(meta.width).toBeNull();
    expect(meta.height).toBeNull();
  });

  it("does not throw on truncated headers", () => {
    for (const bytes of [
      new Uint8Array([0x89, 0x50]),
      new Uint8Array([0xff, 0xd8, 0xff]),
      new Uint8Array([0x52, 0x49, 0x46]),
      new Uint8Array([]),
    ]) {
      const meta = parseImageMetadata(bytes, "image/png");
      expect(meta.bytes).toBe(bytes.byteLength);
    }
  });
});

describe("decodeDataUrl", () => {
  it("decodes base64 data URLs with MIME type", () => {
    const png = makePng(10, 20);
    const url = `data:image/png;base64,${png.toString("base64")}`;
    const decoded = decodeDataUrl(url);
    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe("image/png");
    expect(decoded!.bytes.byteLength).toBe(png.byteLength);
  });

  it("returns null for malformed input", () => {
    expect(decodeDataUrl("not-a-data-url")).toBeNull();
    // Percent-encoded (non-base64) data URL with a bad escape → null.
    expect(decodeDataUrl("data:,100%bad")).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("formatBytes renders human sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formatImageMetadata renders dims + format + size", () => {
    expect(
      formatImageMetadata({
        format: "png",
        width: 800,
        height: 600,
        bytes: 46336,
      }),
    ).toBe("800×600 PNG, 45.3 KB");
    expect(
      formatImageMetadata({ format: "gif", width: null, height: null, bytes: 10 }),
    ).toBe("GIF, 10 B");
  });
});
