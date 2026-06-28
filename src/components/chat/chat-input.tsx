"use client";

import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { ArrowUp, Square, Paperclip, X } from "lucide-react";
import { useImageAttachments } from "@/hooks/use-image-attachments";

interface ChatInputProps {
  onSubmit: (message: string) => void;
  isLoading: boolean;
  onStop?: () => void;
}

export function ChatInput({ onSubmit, isLoading, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { images, removeImage, clearImages, handlePaste, handleDrop, handleDragOver } = useImageAttachments();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    if (isLoading) return;

    let message = trimmed;
    if (images.length > 0) {
      message = trimmed ? `[Images attached]\n\n${trimmed}` : "[Images attached]";
    }

    onSubmit(message);
    setValue("");
    clearImages();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const valid = Array.from(files).filter((f) => f.type.startsWith("image/"));
      // Add via our hook's internal addFiles... let's do it inline
      for (const f of valid) {
        if (f.size <= 10 * 1024 * 1024) {
          images.push(f);
        }
      }
    }
  };

  return (
    <div
      className="overflow-hidden rounded-2xl bg-muted transition-colors"
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-4 pt-3 flex-wrap">
          {images.map((file, i) => (
            <div key={i} className="relative group">
              <img
                src={URL.createObjectURL(file)}
                alt={file.name}
                className="h-16 w-16 rounded-lg object-cover border border-border"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-muted-foreground/80 text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Textarea */}
      <div className="px-4 pb-2 pt-3">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          placeholder="Send a message..."
          disabled={isLoading}
          rows={1}
          className="w-full resize-none overflow-y-auto bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none text-sm"
          style={{ minHeight: "24px", maxHeight: "72px" }}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        {/* Left side */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input ref={fileInputRef} type="file" multiple onChange={handleFileChange} className="hidden" accept="image/*" />
        </div>

        {/* Right side */}
        <div className="flex shrink-0 items-center gap-1">
          {isLoading && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="h-8 w-8 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 flex items-center justify-center"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!value.trim() && images.length === 0}
              onClick={handleSubmit}
              className="h-8 w-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 flex items-center justify-center transition-colors"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
