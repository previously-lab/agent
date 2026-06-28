"use client";

import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Square, Paperclip, X } from "lucide-react";

interface ChatInputProps {
  onSubmit: (message: string) => void;
  isLoading: boolean;
  onStop?: () => void;
}

export function ChatInput({ onSubmit, isLoading, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && files.length === 0) return;
    if (isLoading) return;

    let message = trimmed;
    if (files.length > 0) {
      const fileNames = files.map((f) => f.name).join(", ");
      message = trimmed
        ? `[Attachments: ${fileNames}]\n\n${trimmed}`
        : `[Attachments: ${fileNames}]`;
    }

    onSubmit(message);
    setValue("");
    setFiles([]);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    const valid = selected.filter((f) => {
      if (f.size > 10 * 1024 * 1024) {
        return false;
      }
      return true;
    });
    setFiles((prev) => [...prev, ...valid]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <form onSubmit={handleSubmit} className="border-t border-border bg-background">
      {files.length > 0 && (
        <div className="flex gap-2 px-4 pt-2 flex-wrap">
          {files.map((file, i) => (
            <div key={i} className="flex items-center gap-1.5 rounded bg-muted px-2 py-1 text-xs">
              <span className="max-w-[120px] truncate">{file.name}</span>
              <button type="button" onClick={() => removeFile(i)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 p-3 sm:p-4">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Attach files"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        <input ref={fileInputRef} type="file" multiple onChange={handleFileChange} className="hidden" accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html" />
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
          className="flex-1 min-h-[44px] max-h-[200px] resize-none rounded-md border border-input bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        {isLoading && onStop ? (
          <Button type="button" variant="outline" size="icon" onClick={onStop} className="min-h-[44px] min-w-[44px] shrink-0" title="Stop generation">
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!value.trim() && files.length === 0} className="min-h-[44px] min-w-[44px] shrink-0" title="Send message">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Button>
        )}
      </div>
    </form>
  );
}
