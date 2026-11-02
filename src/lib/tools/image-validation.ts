import { IMAGE_ATTACHMENT_LIMITS } from "@/lib/chat/image-attachments";

export class ImageAttachmentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
/** Read raster signatures and intrinsic dimensions without executing a decoder
 * or trusting the extension/client MIME. SVG is deliberately not an upload. */
export function inspectImage(data: Buffer): { mediaType: string; extension: string; width: number; height: number } {
  if (!data.length || data.length > IMAGE_ATTACHMENT_LIMITS.maxBytes) throw new ImageAttachmentError("image_size", "Image must be between 1 byte and 5MB", 413);
  let width = 0, height = 0, mediaType = "", extension = "";
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString("ascii", 12, 16) === "IHDR") {
    let offset = 8, ended = false, pixels = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset), kind = data.toString("ascii", offset + 4, offset + 8);
      if (offset + size + 12 > data.length) break;
      if (kind === "IDAT" && size > 0) pixels = true;
      offset += size + 12;
      if (kind === "IEND" && size === 0) { ended = offset === data.length; break; }
    }
    if (ended && pixels && data.readUInt32BE(8) === 13) { width = data.readUInt32BE(16); height = data.readUInt32BE(20); mediaType = "image/png"; extension = "png"; }
  } else if (data.length >= 14 && data.at(-1) === 0x3b && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) {
    width = data.readUInt16LE(6); height = data.readUInt16LE(8); mediaType = "image/gif"; extension = "gif";
  } else if (data.length >= 12 && data[0] === 255 && data[1] === 216 && data.at(-2) === 255 && data.at(-1) === 217) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); mediaType = "image/jpeg"; extension = "jpg"; break;
      }
      offset += length;
    }
  } else if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" && data.readUInt32LE(4) + 8 <= data.length) {
    const kind = data.toString("ascii", 12, 16);
    if (kind === "VP8X" && data.readUInt32LE(16) >= 10) { width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3); }
    else if (kind === "VP8 " && data[23] === 0x9d && data[24] === 1 && data[25] === 0x2a) { width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff; }
    else if (kind === "VP8L" && data[20] === 0x2f) { const bits = data.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
    mediaType = "image/webp"; extension = "webp";
  }
  if (!width || !height || width > 16_384 || height > 16_384 || width * height > 40_000_000) {
    throw new ImageAttachmentError("image_format", "Use a valid JPEG, PNG, GIF or WebP image within 40 megapixels", 415);
  }
  return { mediaType, extension, width, height };
}
