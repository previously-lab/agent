/**
 * Attachment display model for the memory shelf (v0.19 §C.1) — the pure
 * half of the rendering: which attachments are images (rendered inline via
 * /api/attachments) vs files (linked open). Kept free of React so the
 * partition logic is unit-testable in the node environment (the repo has no
 * component-test runtime, and deps are frozen).
 */

export interface CaseAttachmentLike {
  name: string;
  image: boolean;
}

export interface AttachmentDisplayItem {
  name: string;
  /** The /api/attachments URL — the browser pulls bytes, never base64. */
  url: string;
}

export interface AttachmentDisplayModel {
  images: AttachmentDisplayItem[];
  files: AttachmentDisplayItem[];
}

/** One attachment's serving URL: /api/attachments?ref=<分类>/<case名>/<附件名>. */
export function attachmentUrl(category: string, caseName: string, fileName: string): string {
  return `/api/attachments?ref=${encodeURIComponent(`${category}/${caseName}/${fileName}`)}`;
}

/**
 * Partition a case's attachments for display. Returns NULL when there is
 * nothing to show — the shelf section stays hidden entirely.
 */
export function buildAttachmentDisplay(detail: {
  category: string;
  name: string;
  attachments: CaseAttachmentLike[];
}): AttachmentDisplayModel | null {
  if (detail.attachments.length === 0) return null;
  const images: AttachmentDisplayItem[] = [];
  const files: AttachmentDisplayItem[] = [];
  for (const att of [...detail.attachments].sort((a, b) => a.name.localeCompare(b.name))) {
    const item = { name: att.name, url: attachmentUrl(detail.category, detail.name, att.name) };
    if (att.image) images.push(item);
    else files.push(item);
  }
  return { images, files };
}
