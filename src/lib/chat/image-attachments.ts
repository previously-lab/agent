/** Serializable image identities shared by the editor, records and readers.
 * No filesystem, credentials, or server imports belong in this module. */
export const IMAGE_ATTACHMENT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxPerTurn: 4, maxOrdinal: 1_000_000 } as const;
export const IMAGE_ASSET_ID = /^img_[a-f0-9]{32}$/;

export interface ImageAttachmentSnapshot {
  version: 1;
  assetId: string;
  ref: string;
  name: string;
  mediaType: string;
  byteSize?: number;
  width?: number;
  height?: number;
  /** Assigned once by the editor; deleting an earlier image never renumbers it. */
  ordinal?: number;
}
export interface StagedAttachmentRef { assetId: string; ordinal: number }
/** Internal durable payload. Only server-verified bytes may populate this. */
export interface ImageAttachmentEvidence { snapshot: ImageAttachmentSnapshot; dataBase64: string }

export function isImageOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= IMAGE_ATTACHMENT_LIMITS.maxOrdinal;
}
export function isAttachmentFileName(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value === value.trim()
    && !/[\\/:\x00-\x1f\x7f]/.test(value) && !value.includes("..");
}
export function parseRecordImageRef(ref: string): { sliceId: string; fileName: string } | null {
  const match = /^records\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/([^/]+)$/.exec(ref);
  if (!match || !isAttachmentFileName(match[5])) return null;
  const [, year, month, day, time, fileName] = match;
  const iso = `${year}-${month}-${day}T${time.slice(0, 2)}:${time.slice(2)}:00.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) return null;
  return { sliceId: `${year}-${month}-${day}-${time}`, fileName };
}
export function recordImageRef(sliceId: string, fileName: string): string {
  const ref = `records/${sliceId.replace(/-/g, "/")}/${fileName}`;
  if (!parseRecordImageRef(ref)) throw new Error("Invalid record image reference");
  return ref;
}
export function imageAttachmentUrl(ref: string, persona?: string): string {
  return `/api/attachments?ref=${encodeURIComponent(ref)}${persona ? `&persona=${encodeURIComponent(persona)}` : ""}`;
}
/** Request validation is all-or-nothing, never silently drops or renumbers. */
export function parseStagedAttachments(value: unknown): StagedAttachmentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > IMAGE_ATTACHMENT_LIMITS.maxPerTurn) throw new Error("Invalid stagedAttachments list");
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.assetId !== "string"
      || !IMAGE_ASSET_ID.test(entry.assetId) || !isImageOrdinal(entry.ordinal)
      || ids.has(entry.assetId) || ordinals.has(entry.ordinal)) throw new Error("Invalid or duplicate staged attachment");
    ids.add(entry.assetId); ordinals.add(entry.ordinal);
    return { assetId: entry.assetId, ordinal: entry.ordinal };
  });
}
/** Tolerant record reader: malformed metadata never makes the prose unreadable. */
export function parseImageAttachments(value: unknown): ImageAttachmentSnapshot[] {
  if (!Array.isArray(value) || value.length > IMAGE_ATTACHMENT_LIMITS.maxPerTurn) return [];
  const ids = new Set<string>(); const ordinals = new Set<number>();
  const result: ImageAttachmentSnapshot[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || entry.version !== 1
      || typeof entry.assetId !== "string" || (!IMAGE_ASSET_ID.test(entry.assetId) && !/^legacy-[a-f0-9]{16,64}$/.test(entry.assetId))
      || typeof entry.ref !== "string" || (!parseRecordImageRef(entry.ref) && entry.ref !== `drafts/${entry.assetId}`)
      || typeof entry.name !== "string" || !isAttachmentFileName(entry.name)
      || !/^image\/(jpeg|png|gif|webp|svg\+xml|avif|bmp)$/.test(entry.mediaType)
      || ids.has(entry.assetId) || (entry.ordinal !== undefined && (!isImageOrdinal(entry.ordinal) || ordinals.has(entry.ordinal)))) continue;
    if (["byteSize", "width", "height"].some((key) => entry[key] !== undefined && (!Number.isSafeInteger(entry[key]) || entry[key] <= 0))) continue;
    ids.add(entry.assetId); if (entry.ordinal !== undefined) ordinals.add(entry.ordinal);
    result.push({ version: 1, assetId: entry.assetId, ref: entry.ref, name: entry.name, mediaType: entry.mediaType,
      ...(entry.byteSize === undefined ? {} : { byteSize: entry.byteSize }),
      ...(entry.width === undefined ? {} : { width: entry.width }), ...(entry.height === undefined ? {} : { height: entry.height }),
      ...(entry.ordinal === undefined ? {} : { ordinal: entry.ordinal }) });
  }
  return result;
}
export function encodeImageAttachments(value: ImageAttachmentSnapshot[]): string {
  return encodeURIComponent(JSON.stringify({ version: 1, attachments: parseImageAttachments(value) }));
}
export function decodeImageAttachments(value: unknown): ImageAttachmentSnapshot[] {
  if (typeof value !== "string" || value.length > 20_000) return [];
  try {
    const envelope = JSON.parse(decodeURIComponent(value));
    return envelope?.version === 1 ? parseImageAttachments(envelope.attachments).filter((image) => parseRecordImageRef(image.ref)) : [];
  } catch { return []; }
}

/** Compatibility only for a recognized persisted user turn. Old markers were
 * appended at the end and named every file with that turn's ID. Never treat
 * arbitrary prose or a supplied path as an attachment manifest. */
export function legacyRecordImageAttachments(content: string, sliceId: string, turnId?: string): ImageAttachmentSnapshot[] {
  if (!turnId || !isAttachmentFileName(turnId)) return [];
  const marker = /\n\n\[attachments: ([^\r\n]+)\]\s*$/.exec(content);
  if (!marker) return [];
  const names = marker[1].split(", ");
  if (names.length > IMAGE_ATTACHMENT_LIMITS.maxPerTurn || names.some((name) => !isAttachmentFileName(name) || !name.startsWith(`${turnId}-`))) return [];
  const media: Record<string, string> = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", gif: "gif", svg: "svg+xml", avif: "avif", bmp: "bmp" };
  return names.flatMap((name, index) => {
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (!media[extension]) return [];
    let ref: string; try { ref = recordImageRef(sliceId, name); } catch { return []; }
    // A deterministic UI identity, not a capability or a server claim token.
    let a = 2166136261, b = 3339675911;
    for (const character of ref) { a = Math.imul(a ^ character.charCodeAt(0), 16777619); b = Math.imul(b ^ character.charCodeAt(0), 2246822519); }
    const id = [a, b].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
    return [{ version: 1 as const, assetId: `legacy-${id}`, ref, name, mediaType: `image/${media[extension]}`, ordinal: index + 1 }];
  });
}
