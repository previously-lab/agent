/**
 * Dependency-free image metadata extraction — dimensions, format, byte size.
 *
 * Hand-rolled header parsing for PNG / JPEG / GIF / WebP (no sharp, no native
 * codecs): we only read magic bytes and size fields, never decode pixel data.
 * Used by the vision path to attach metadata to every describeImage result
 * and to power the degraded (vision-model-unavailable) response.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "unknown";

export type ImageMetadata = {
  format: ImageFormat;
  /** Pixels; null when the header does not carry a parseable size. */
  width: number | null;
  height: number | null;
  /** Decoded image byte length. */
  bytes: number;
};

/** Reject absurd dimensions so garbage headers never produce nonsense. */
const MAX_DIM = 1_000_000;

const FORMAT_LABELS: Record<ImageFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
  unknown: "unknown",
};

const MIME_FORMATS: Record<string, ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function formatLabel(format: ImageFormat): string {
  return FORMAT_LABELS[format];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact one-line rendering, e.g. "800×600 PNG, 45.2 KB". */
export function formatImageMetadata(meta: ImageMetadata): string {
  const dims =
    meta.width !== null && meta.height !== null
      ? `${meta.width}×${meta.height} `
      : "";
  return `${dims}${formatLabel(meta.format)}, ${formatBytes(meta.bytes)}`;
}

function sane(w: number, h: number): boolean {
  return (
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= MAX_DIM &&
    h <= MAX_DIM
  );
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32be(b: Uint8Array, o: number): number {
  return (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
}

function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

function startsWith(b: Uint8Array, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i++) {
    if (b[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function parsePng(b: Uint8Array): { width: number; height: number } | null {
  // 8-byte magic, then the first chunk must be IHDR (len 13).
  if (b.length < 24 || !startsWith(b, "\x89PNG\r\n\x1a\n")) return null;
  if (!startsWith(b.subarray(12), "IHDR")) return null;
  const w = u32be(b, 16);
  const h = u32be(b, 20);
  return sane(w, h) ? { width: w, height: h } : null;
}

function parseGif(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10 || (!startsWith(b, "GIF87a") && !startsWith(b, "GIF89a")))
    return null;
  const w = u16le(b, 6);
  const h = u16le(b, 8);
  return sane(w, h) ? { width: w, height: h } : null;
}

// JPEG SOF markers (frame headers carry dimensions). Excluded: DHT (C4),
// JPG (C8), DAC (CC) — same Cx range but no dimensions.
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

function parseJpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 <= b.length) {
    if (b[pos] !== 0xff) return null; // lost segment sync — give up
    let marker = b[pos + 1]!;
    // Skip fill bytes (0xFF padding) between segments.
    let fill = 0;
    while (marker === 0xff && pos + 2 + fill < b.length) {
      fill++;
      marker = b[pos + 1 + fill]!;
    }
    pos += fill;
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    const len = u16be(b, pos + 2);
    if (len < 2) return null;
    if (JPEG_SOF.has(marker)) {
      // Layout after marker+len: precision(1), height(2), width(2).
      const h = u16be(b, pos + 5);
      const w = u16be(b, pos + 7);
      return sane(w, h) ? { width: w, height: h } : null;
    }
    pos += 2 + len;
  }
  return null;
}

function parseWebp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 20 || !startsWith(b, "RIFF") || !startsWith(b.subarray(8), "WEBP"))
    return null;
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === "VP8X" && b.length >= 30) {
    const w = u24le(b, 24) + 1;
    const h = u24le(b, 27) + 1;
    return sane(w, h) ? { width: w, height: h } : null;
  }
  if (fourcc === "VP8 " && b.length >= 30) {
    const w = u16le(b, 26) & 0x3fff;
    const h = u16le(b, 28) & 0x3fff;
    return sane(w, h) ? { width: w, height: h } : null;
  }
  if (fourcc === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits =
      b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >>> 14) & 0x3fff) + 1;
    return sane(w, h) ? { width: w, height: h } : null;
  }
  return null;
}

/**
 * Extract metadata from raw image bytes. Format comes from magic bytes; a
 * MIME hint (from a data URL or HTTP content type) is only used as a
 * fallback when the magic bytes are unrecognized. Never throws.
 */
export function parseImageMetadata(
  bytes: Uint8Array,
  mimeHint?: string,
): ImageMetadata {
  let format: ImageFormat = "unknown";
  let dims: { width: number; height: number } | null = null;

  if (bytes.length >= 8 && startsWith(bytes, "\x89PNG")) {
    format = "png";
    dims = parsePng(bytes);
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = "jpeg";
    dims = parseJpeg(bytes);
  } else if (bytes.length >= 6 && startsWith(bytes, "GIF8")) {
    format = "gif";
    dims = parseGif(bytes);
  } else if (bytes.length >= 12 && startsWith(bytes, "RIFF")) {
    format = "webp";
    dims = parseWebp(bytes);
  } else if (mimeHint && MIME_FORMATS[mimeHint.toLowerCase()]) {
    format = MIME_FORMATS[mimeHint.toLowerCase()]!;
  }

  return {
    format,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    bytes: bytes.byteLength,
  };
}

/**
 * Decode a data URL into raw bytes plus its declared MIME type. Returns null
 * for malformed input; non-base64 data URLs are percent-decoded.
 */
export function decodeDataUrl(
  dataUrl: string,
): { bytes: Uint8Array; mimeType?: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mimeType = m[1] ? m[1] : undefined;
  try {
    if (m[2]) {
      return { bytes: new Uint8Array(Buffer.from(m[3]!, "base64")), mimeType };
    }
    return {
      bytes: new TextEncoder().encode(decodeURIComponent(m[3]!)),
      mimeType,
    };
  } catch {
    return null;
  }
}
