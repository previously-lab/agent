"use client";

import { useState, useCallback, type DragEvent, type ClipboardEvent } from "react";

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export function useImageAttachments() {
  const [images, setImages] = useState<File[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const valid = Array.from(files).filter((f) => {
      if (f.size > MAX_SIZE) return false;
      return f.type.startsWith("image/");
    });
    setImages((prev) => [...prev, ...valid]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearImages = useCallback(() => setImages([]), []);

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.files;
      if (items?.length) addFiles(items);
    },
    [addFiles]
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  return { images, addFiles, removeImage, clearImages, handlePaste, handleDrop, handleDragOver };
}
