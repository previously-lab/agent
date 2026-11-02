import { createHash } from "node:crypto";
import type { UIMessage } from "@/lib/chat/protocol";
import { IMAGE_ATTACHMENT_LIMITS, type ImageAttachmentEvidence } from "@/lib/chat/image-attachments";
import { inspectImage, ImageAttachmentError } from "./image-validation";
import { sanitizeAttachmentName } from "./attachments";

/** Legacy data URLs are decoded locally; a client URL is never fetched. */
export function legacyMessageImages(messages: UIMessage[]): ImageAttachmentEvidence[] {
  const last = messages.findLast((message) => message.role === "user");
  const files = last?.parts.filter((part) => part.type === "file") ?? [];
  if (files.length > IMAGE_ATTACHMENT_LIMITS.maxPerTurn) throw new ImageAttachmentError("image_count", "Attach at most four images");
  return files.map((part, index) => {
    if (part.type !== "file" || typeof part.url !== "string" || part.url.length > IMAGE_ATTACHMENT_LIMITS.maxBytes * 4 / 3 + 256) throw new ImageAttachmentError("image_size", "Invalid image payload", 413);
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.url);
    if (!match || match[1].length % 4 !== 0) throw new ImageAttachmentError("image_format", "Images must be uploaded before sending");
    const data = Buffer.from(match[1], "base64"), image = inspectImage(data);
    const assetId = `legacy-${createHash("sha256").update(data).update(`:${index}`).digest("hex").slice(0, 32)}`;
    const stem = sanitizeAttachmentName(part.filename ?? `image-${index + 1}`).replace(/\.[^.]*$/, "").slice(0, 160) || "image";
    return { snapshot: { version: 1, assetId, ref: `drafts/${assetId}`, name: `${stem}.${image.extension}`,
      mediaType: image.mediaType, byteSize: data.length, width: image.width, height: image.height, ordinal: index + 1 }, dataBase64: data.toString("base64") };
  });
}
/** Historical files become textual pointers. Only this message's verified
 * images enter model conversion, preventing client URL/path based reads. */
export function withVerifiedImages(messages: UIMessage[], attachments: ImageAttachmentEvidence[]): UIMessage[] {
  const lastIndex = messages.findLastIndex((message) => message.role === "user");
  return messages.map((message, index) => ({ ...message,
    parts: [
      ...message.parts.filter((part) => part.type !== "file"),
      ...(index === lastIndex ? attachments.flatMap(({ snapshot, dataBase64 }, imageIndex) => ([
        { type: "text" as const, text: `[Image mapping: 〔图${snapshot.ordinal ?? imageIndex + 1}〕 = ${snapshot.name}; assetId=${snapshot.assetId}; viewImage source="attachment:${imageIndex}". The displayed number is not the tool index.]` },
        { type: "file" as const, url: `data:${snapshot.mediaType};base64,${dataBase64}`, mediaType: snapshot.mediaType, filename: snapshot.name },
      ])) : message.parts.filter((part) => part.type === "file").map(() => ({ type: "text" as const, text: "[image from earlier message]" }))),
    ],
  }));
}
