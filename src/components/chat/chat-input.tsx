"use client";

import { useState, useRef, useEffect, useLayoutEffect, useId, type FormEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, AtSign, Maximize2, Square, Paperclip, Radio, X } from "lucide-react";
import { toast } from "sonner";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requestCompanionPanelOpen } from "@/lib/chat/companion-panel";
import { appendNativeDraft, NATIVE_DRAFT_EVENT } from "@/lib/chat/native-draft";
import { getComposerState } from "@/lib/chat/composer-state";
import type { DocumentCatalogItem } from "@/lib/chat/document-catalog-actions";
import {
  findDocumentMentionRange,
  isImeKeyboardEvent,
  nextDocumentMentionIndex,
  removeDocumentMentionRange,
  type DocumentMentionRange,
} from "@/lib/chat/document-mentions";
import { reducePanelMode, usePanelTier } from "./conversation-panel";
import { useDocumentContext } from "./document-context-provider";
import { useNativePersona } from "./native-source-scope";
import {
  DocumentMentionPicker,
  DocumentReferenceChips,
  useDocumentMentionCatalog,
} from "./document-mention-picker";
import "./writing.css";
import "./document-mentions.css";

/** The manuscript grows with the stream. Only the compact pill has an
 *  internal ceiling; fullscreen writing uses a larger focused floor and then
 *  follows its natural height. */
const TEXTAREA_MIN_PX = 44;
const TEXTAREA_EDITING_MIN_PX = 88;
const PILL_TEXTAREA_MIN_PX = 24;
const PILL_TEXTAREA_MAX_PX = 44;

interface ChatInputProps {
  onSubmit: (message: string, images: File[]) => void;
  isLoading: boolean;
  onStop?: () => void;
}

/**
 * The evolution stream's entry — one click opens the companion pod's HQ
 * panel (the field↔HQ activity face). The pod owns the panel; this button
 * only publishes a request on the companion-panel bus
 * (`lib/chat/companion-panel.ts`), so every composer form shares it verbatim.
 */
function HQStreamButton({
  className,
  iconClassName,
}: {
  className: string;
  iconClassName: string;
}) {
  const t = useTranslations("chat.input");
  return (
    <button
      type="button"
      data-hq-stream
      onClick={() => requestCompanionPanelOpen()}
      aria-label={t("hqStream")}
      title={t("hqStream")}
      className={className}
    >
      <Radio aria-hidden className={iconClassName} />
    </button>
  );
}

function ImageAttachmentPreview({
  file,
  removeLabel,
  onRemove,
}: {
  file: File;
  removeLabel: string;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  return (
    <div className="relative group" data-attachment-preview>
      <img src={url} alt={file.name} className="h-16 w-16 rounded-lg border border-border object-cover" />
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="conversation-attachment-remove absolute -top-1.5 -right-1.5 h-6 w-6 bg-foreground text-background flex items-center justify-center"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function ChatInput({
  onSubmit,
  isLoading,
  onStop,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const tDesk = useTranslations("desk");
  const tPanel = useTranslations("conversationPanel");
  const tier = usePanelTier();
  const mentionId = useId();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<{
    open: boolean;
    manual: boolean;
    query: string;
    range: DocumentMentionRange | null;
  }>({ open: false, manual: false, query: "", range: null });
  const { references, addReference, removeReference } = useDocumentContext();
  const persona = useNativePersona() ?? "user";
  const catalog = useDocumentMentionCatalog(mention.open, mention.query, persona);
  const { images, removeImage, clearImages, handlePaste, handleDrop } = useImageAttachments();

  const closeMention = () => {
    setMention({ open: false, manual: false, query: "", range: null });
  };

  const openManualMention = () => {
    setMention((current) => current.open && current.manual
      ? { open: false, manual: false, query: "", range: null }
      : { open: true, manual: true, query: "", range: null });
  };

  useEffect(() => {
    const onDraft = (event: Event): void => {
      const suggestion = (event as CustomEvent<{ suggestion?: unknown }>).detail?.suggestion;
      if (typeof suggestion !== "string" || suggestion.length > 2_000) return;
      setValue((current) => {
        const next = appendNativeDraft(current, suggestion);
        return next.length <= 12_000 ? next : current;
      });
    };
    window.addEventListener(NATIVE_DRAFT_EVENT, onDraft);
    return () => window.removeEventListener(NATIVE_DRAFT_EVENT, onDraft);
  }, []);

  // One textarea survives every tier. Re-measure after typing, focusing and
  // crossing a tier so the same draft stays visible without remounting it.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onPill = tier?.mode === "pill";
    const floor = onPill
      ? PILL_TEXTAREA_MIN_PX
      : focused
        ? TEXTAREA_EDITING_MIN_PX
        : TEXTAREA_MIN_PX;
    // Manuscript drafts belong to the page's scroll extent, not an inner
    // textarea scrollbar. Only the compact pill caps and scrolls its input.
    el.style.height = "0px";
    const naturalHeight = Math.max(floor, el.scrollHeight);
    el.style.height = `${onPill ? Math.min(naturalHeight, PILL_TEXTAREA_MAX_PX) : naturalHeight}px`;
  }, [value, focused, tier?.mode]);

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    closeMention();
    // v0.30 §4.1: sending is NOT blocked while a run streams — the page
    // routes the message into the live episode (or starts a fresh turn).
    onSubmit(trimmed, images);
    setValue("");
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_MIN_PX}px`;
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    setValue(next);
    setMention((current) => {
      const range = findDocumentMentionRange(next, caret);
      if (range) return { open: true, manual: false, query: range.query, range };
      return current.manual ? current : { open: false, manual: false, query: "", range: null };
    });
  };

  const selectDocument = (item: DocumentCatalogItem) => {
    if (!addReference({ ref: item.ref, title: item.title })) {
      toast.error(t("references.limit"));
      return;
    }
    if (mention.range) {
      const range = mention.range;
      setValue((current) => removeDocumentMentionRange(current, range));
    }
    if (mention.manual) {
      setMention((current) => ({ ...current, query: "" }));
    } else {
      closeMention();
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      // Composition confirmation belongs to the IME. Do not cancel it, close
      // the mention picker, or send the manuscript before composition ends.
      if (isImeKeyboardEvent(e.nativeEvent)) return;
      e.preventDefault();
      if (mention.open) {
        const item = catalog.items[catalog.activeIndex];
        if (item) selectDocument(item);
        return;
      }
      handleSubmit();
      return;
    }
    if (!mention.open || isImeKeyboardEvent(e.nativeEvent)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      catalog.setActiveIndex(nextDocumentMentionIndex(catalog.activeIndex, catalog.items.length, e.key));
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
  const onPill = tier?.mode === "pill";
  const composerState = getComposerState({
    focused,
    value,
    attachmentCount: images.length,
    mentionOpen: mention.open,
    isLoading,
  });

  return (
    <div
      data-manuscript-composer
      data-composer-state={composerState}
      data-panel-form={onPill ? "pill" : "manuscript"}
      data-composer-pill={onPill ? "" : undefined}
      data-pill-composer={onPill ? "" : undefined}
      aria-busy={isLoading || undefined}
      aria-live="off"
      className={`conversation-composer composer-bar relative ${onPill ? "conversation-composer--pill" : "conversation-composer--manuscript"} ${isDragOver ? "is-dragover" : ""}`}
      onPaste={handlePaste}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <header className="conversation-byline conversation-composer-byline">
        <span className="conversation-speaker">{tDesk("recordUser")}</span>
      </header>

      <div className="conversation-composer-writing">
        {references.length > 0 && (
          <div className="conversation-composer-references">
            <DocumentReferenceChips references={references} onRemove={removeReference} floating={onPill} />
          </div>
        )}
        {mention.open && (
          <div className="conversation-composer-mention">
            <DocumentMentionPicker
              id={mentionId}
              query={mention.query}
              catalog={catalog}
              manual={mention.manual}
              floating={onPill}
              onQueryChange={(query) => setMention((current) => ({ ...current, query }))}
              onSelect={selectDocument}
              onClose={closeMention}
              onKeyDown={handleKeyDown}
            />
          </div>
        )}
        {images.length > 0 && (
          <div className="conversation-composer-attachments" data-composer-attachments>
            {images.map((file, i) => (
              <ImageAttachmentPreview
                key={`${file.name}:${file.lastModified}:${file.size}:${i}`}
                file={file}
                removeLabel={t("removeAttachment", { name: file.name })}
                onRemove={() => removeImage(i)}
              />
            ))}
          </div>
        )}
        <div className="conversation-composer-draft">
          <textarea
            ref={textareaRef}
            data-manuscript-input
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mention.open}
            aria-controls={mention.open ? `${mentionId}-listbox` : undefined}
            aria-activedescendant={mention.open && catalog.items[catalog.activeIndex] ? `${mentionId}-option-${catalog.activeIndex}` : undefined}
            rows={1}
            className="w-full resize-none bg-transparent focus:outline-none"
          />
        </div>
      </div>

      <div className="conversation-composer-toolbar" data-composer-mini-toolbar>
        <div className="conversation-composer-toolbar-left">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-attach
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t("attach")}
                  className="conversation-control"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              }
            />
            <TooltipContent side="top">{t("attach")}</TooltipContent>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
            accept="image/*"
          />
          <HQStreamButton className="conversation-control" iconClassName="h-3.5 w-3.5" />
          <button
            type="button"
            data-document-mention
            onClick={openManualMention}
            aria-label={t("references.open")}
            title={t("references.open")}
            aria-expanded={mention.open && mention.manual}
            aria-controls={mention.open ? `${mentionId}-listbox` : undefined}
            className="conversation-control"
          >
            <AtSign aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="conversation-composer-toolbar-right">
          {onPill && (
            <button
              type="button"
              data-pill-expand
              onClick={() => tier && tier.setMode(reducePanelMode(tier.mode, "toggleFullscreen"))}
              aria-label={tPanel("expand")}
              title={tPanel("expand")}
              className="conversation-control"
            >
              <Maximize2 aria-hidden className="size-4" />
            </button>
          )}
          {isLoading && onStop && (
            <button
              type="button"
              data-composer-stop
              onClick={onStop}
              aria-label={t("stopTooltip")}
              className="conversation-control conversation-control--stop"
              title={t("stopTooltip")}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          )}
          <button
            type="submit"
            data-composer-send
            onClick={(e) => handleSubmit(e as unknown as FormEvent)}
            disabled={!hasContent}
            aria-label={t("sendTooltip")}
            className={`conversation-control ${hasContent ? "conversation-send" : ""}`}
            title={t("sendTooltip")}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
