"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { parseImageAttachments } from "@/lib/chat/image-attachments";
import { createImageAttachmentDraft } from "@/lib/chat/image-attachment-draft";

/**
 * Longest-side cap before upload. Vision APIs bill images by dimensions
 * (DeepSeek converts pixels to input tokens), so a 24MP phone photo costs the
 * same as a page of text many times over — 1568px keeps detail the model can
 * actually use while bounding token spend.
 */
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 0.85;

/**
 * Downscale + re-encode an image for upload. Falls back to the original file
 * when canvas processing is unavailable (SVG, exotic formats, decode failure).
 * Never returns a LARGER file than the original.
 */
async function compressImage(file: File): Promise<File> {
  try {
    // Keep animated formats intact. PNG stays PNG so transparent pixels never
    // become a JPEG's opaque black background; APNG must keep its frames too.
    if (file.type !== "image/jpeg" && file.type !== "image/png") return file;
    if (file.type === "image/png") {
      const bytes = new DataView(await file.arrayBuffer());
      for (let offset = 8; offset + 12 <= bytes.byteLength;) {
        const kind = bytes.getUint32(offset + 4);
        if (kind === 0x6163544c) return file; // acTL, before the first IDAT
        if (kind === 0x49444154) break;
        offset += bytes.getUint32(offset) + 12;
      }
    }
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    // Already small enough AND already a web-efficient format — send as-is.
    if (scale >= 1) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, {
      type: file.type,
    });
  } catch {
    return file;
  }
}

export function useImageAttachments({ scope, persona }: { scope: string; persona: string }) {
  const { draft } = useMemo(() => ({ scope, draft: createImageAttachmentDraft({
    prepare: compressImage,
    mintId: () => crypto.randomUUID(),
    upload: async (file, signal) => {
      const body = new FormData();
      body.set("file", file);
      body.set("persona", persona);
      const response = await fetch("/api/attachments/upload", { method: "POST", body, signal });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error.slice(0, 500) : "upload-failed");
      const attachment = parseImageAttachments([result?.attachment])[0];
      if (!attachment) throw new Error("upload-failed");
      return attachment;
    },
    cancel: async (assetId) => {
      await fetch(`/api/attachments/upload/${encodeURIComponent(assetId)}/cancel?persona=${encodeURIComponent(persona)}`, {
        method: "POST",
      });
    },
  }) }), [scope, persona]);
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  useEffect(() => () => draft.dispose(), [draft]);
  return { ...state, addFiles: draft.add, removeImage: draft.remove, retryImage: draft.retry,
    undoRemove: draft.undo, acceptImages: draft.accept };
}
