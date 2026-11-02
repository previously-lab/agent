import { parseImageAttachments, type ImageAttachmentSnapshot, type StagedAttachmentRef } from "./image-attachments";

export function messageImageAttachments(metadata: unknown): ImageAttachmentSnapshot[] {
  return metadata && typeof metadata === "object" && "attachments" in metadata
    ? parseImageAttachments(metadata.attachments) : [];
}

export function stagedImageReferences(images: readonly ImageAttachmentSnapshot[]): StagedAttachmentRef[] {
  return images.flatMap(image => image.ordinal !== undefined && image.ref === `drafts/${image.assetId}`
    ? [{ assetId: image.assetId, ordinal: image.ordinal }] : []);
}
