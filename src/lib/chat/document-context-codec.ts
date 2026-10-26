import {
  DOCUMENT_CONTEXT_LIMITS,
  createDocumentContextEnvelope,
  parseDocumentContext,
  type DocumentContextSnapshot,
} from "./document-context";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_ENVELOPE_JSON_CHARS = DOCUMENT_CONTEXT_LIMITS.maxTotalChars + 128;
const MAX_ENVELOPE_UTF8_BYTES = MAX_ENVELOPE_JSON_CHARS * 3;
const MAX_ENCODED_CHARS = Math.ceil(MAX_ENVELOPE_UTF8_BYTES / 3) * 4;

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1] : 0;
    const c = hasC ? bytes[index + 2] : 0;
    output += BASE64URL[a >> 2];
    output += BASE64URL[((a & 3) << 4) | (b >> 4)];
    if (hasB) output += BASE64URL[((b & 15) << 2) | (c >> 6)];
    if (hasC) output += BASE64URL[c & 63];
  }
  return output;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

export function encodeDocumentContext(references: DocumentContextSnapshot): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(createDocumentContextEnvelope(references))));
}

export function decodeDocumentContext(value: unknown): DocumentContextSnapshot {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCODED_CHARS) {
    return parseDocumentContext(undefined);
  }
  try {
    const bytes = decodeBase64Url(value);
    if (!bytes) return parseDocumentContext(undefined);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseDocumentContext(JSON.parse(text));
  } catch {
    return parseDocumentContext(undefined);
  }
}
