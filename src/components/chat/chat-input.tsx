"use client";

import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { ArrowUp, Square, Paperclip, X, MessageSquare, Clock, Settings } from "lucide-react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ChatInputProps {
  onSubmit: (message: string) => void;
  isLoading: boolean;
  onStop?: () => void;
}

export function ChatInput({ onSubmit, isLoading, onStop }: ChatInputProps) {
  const pathname = usePathname();
  const isTimeline = pathname?.endsWith("/timeline");
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const { images, removeImage, clearImages, handlePaste, handleDrop, handleDragOver } = useImageAttachments();

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "24px";
    el.style.height = Math.min(el.scrollHeight, 72) + "px";
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    if (isLoading) return;

    let message = trimmed;
    if (images.length > 0) {
      message = trimmed ? `${trimmed}` : "";
    }

    onSubmit(message);
    setValue("");
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "24px";
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    resizeTextarea();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const valid = Array.from(files).filter(
      (f) => f.type.startsWith("image/") && f.size <= 10 * 1024 * 1024
    );
    if (valid.length > 0) {
      // manually add valid files
      const dt = new DataTransfer();
      valid.forEach((f) => dt.items.add(f));
      const syntheticEvent = { clipboardData: dt } as unknown as React.ClipboardEvent;
      handlePaste(syntheticEvent);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    setIsDragOver(false);
    handleDrop(e);
  };

  const hasContent = value.trim().length > 0 || images.length > 0;

  return (
    <div
      className={`overflow-hidden rounded-2xl bg-muted transition-colors ${isDragOver ? "ring-2 ring-blue-500/50" : ""}`}
      onPaste={handlePaste}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
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
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
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
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {/* Attach */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-7 w-7 rounded-full text-muted-foreground/50 hover:text-foreground hover:bg-muted-foreground/10 transition-colors flex items-center justify-center"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              }
            />
            <TooltipContent side="top">Attach files</TooltipContent>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
            accept="image/*"
          />

          {/* Divider */}
          <span className="w-px h-4 bg-border/50" />

          {/* Chat view link */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  href="/"
                  className={cn(
                    "h-7 flex items-center gap-1 rounded-full px-2.5 text-[0.6rem] font-medium transition-colors",
                    !isTimeline
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground/50 hover:text-foreground hover:bg-muted-foreground/10"
                  )}
                >
                  <MessageSquare className="h-3 w-3" />
                  Chat
                </Link>
              }
            />
            <TooltipContent side="top">Chat view</TooltipContent>
          </Tooltip>

          {/* Timeline view link */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  href="/timeline"
                  className={cn(
                    "h-7 flex items-center gap-1 rounded-full px-2.5 text-[0.6rem] font-medium transition-colors",
                    isTimeline
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground/50 hover:text-foreground hover:bg-muted-foreground/10"
                  )}
                >
                  <Clock className="h-3 w-3" />
                  Timeline
                </Link>
              }
            />
            <TooltipContent side="top">Timeline view</TooltipContent>
          </Tooltip>

          {/* Settings */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  href="/settings"
                  className="h-7 w-7 rounded-full text-muted-foreground/50 hover:text-foreground hover:bg-muted-foreground/10 transition-colors flex items-center justify-center"
                >
                  <Settings className="h-3.5 w-3.5" />
                </Link>
              }
            />
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
        </div>

        {/* Right side */}
        <div className="flex shrink-0 items-center gap-1">
          {isLoading && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="h-8 w-8 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 flex items-center justify-center"
              title="Stop generation"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              onClick={(e) => handleSubmit(e as unknown as FormEvent)}
              disabled={!hasContent}
              className="h-8 w-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 flex items-center justify-center transition-colors"
              title="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
