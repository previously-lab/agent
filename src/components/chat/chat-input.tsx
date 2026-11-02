"use client";

import { useState, useRef, useEffect, useLayoutEffect, useId, type FormEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, AtSign, Maximize2, Plus, Square, Paperclip, Radio } from "lucide-react";
import { toast } from "sonner";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requestCompanionPanelOpen } from "@/lib/chat/companion-panel";
import { appendNativeDraft, NATIVE_DRAFT_EVENT } from "@/lib/chat/native-draft";
import { getComposerState } from "@/lib/chat/composer-state";
import { composerEnterIntent, DEFAULT_COMPOSER_ENTER_BEHAVIOR, type ComposerEnterBehavior } from "@/lib/chat/composer-keyboard";
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
import { useNativePersona, useNativeSourceScope } from "./native-source-scope";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { imageMarkerText, insertImageMarker, selectedImageMarker } from "@/lib/chat/image-markers";
import { ImagePolaroid } from "./conversation-images";
import {
  DocumentMentionPicker,
  DocumentReferenceChips,
  useDocumentMentionCatalog,
} from "./document-mention-picker";
import "./writing.css";
import "./document-mentions.css";

interface ChatInputProps {
  onSubmit: (message: string, images: File[], attachments?: readonly ImageAttachmentSnapshot[], messageId?: string) => void | Promise<void>;
  isLoading: boolean;
  onStop?: () => void;
  enterBehavior?: ComposerEnterBehavior;
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

export function ChatInput({
  onSubmit,
  isLoading,
  onStop,
  enterBehavior = DEFAULT_COMPOSER_ENTER_BEHAVIOR,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const tDesk = useTranslations("desk");
  const tPanel = useTranslations("conversationPanel");
  const tier = usePanelTier();
  const mentionId = useId();
  const toolsId = useId();
  const composerRef = useRef<HTMLDivElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const selectionRef = useRef({ start: 0, end: 0, direction: "none" as "forward" | "backward" | "none" });
  const [draft, setDraft] = useState({ value: "", revision: 0 });
  const value = draft.value;
  // Revision tracks edits, including delete-and-retype to the same text. Text
  // equality cannot distinguish a new draft from the frozen submitted one.
  const setValue = (next: React.SetStateAction<string>) => setDraft(current => ({
    value: typeof next === "function" ? next(current.value) : next,
    revision: current.revision + 1,
  }));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mention, setMention] = useState<{
    open: boolean;
    manual: boolean;
    query: string;
    range: DocumentMentionRange | null;
  }>({ open: false, manual: false, query: "", range: null });
  const { references, addReference, removeReference } = useDocumentContext();
  const persona = useNativePersona() ?? "user";
  const source = useNativeSourceScope();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submissionRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const queuedFilesRef = useRef<File[]>([]);
  const photoRefs = useRef(new Map<string, HTMLElement>());
  const [selectedPhoto, setSelectedPhoto] = useState<string>();
  const catalog = useDocumentMentionCatalog(mention.open, mention.query, persona);
  const { images, removed, limitReached, addFiles, removeImage, retryImage, undoRemove, acceptImages } = useImageAttachments({ scope: source, persona });

  const closeMention = () => {
    setMention({ open: false, manual: false, query: "", range: null });
  };

  const rememberSelection = () => {
    const input = textareaRef.current;
    if (input) selectionRef.current = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  };

  const restoreSelection = () => {
    if (composingRef.current) return;
    const input = textareaRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(selectionRef.current.start, selectionRef.current.end, selectionRef.current.direction);
  };

  const openManualMention = () => {
    rememberSelection();
    setToolsOpen(false);
    setMention((current) => current.open && current.manual
      ? { open: false, manual: false, query: "", range: null }
      : { open: true, manual: true, query: "", range: null });
  };

  useEffect(() => {
    if (!toolsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !composerRef.current?.contains(event.target)) setToolsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [toolsOpen]);

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
    const style = getComputedStyle(el);
    const floor = Number.parseFloat(style.minHeight) || 0;
    const ceiling = Number.parseFloat(style.maxHeight) || Infinity;
    // Manuscript drafts belong to the page's scroll extent, not an inner
    // textarea scrollbar. Only the compact pill caps and scrolls its input.
    el.style.height = "0px";
    const naturalHeight = Math.max(floor, el.scrollHeight);
    el.style.height = `${Math.min(naturalHeight, ceiling)}px`;
  }, [value, focused, toolsOpen, mention.open, tier?.mode, images.length]);

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (composingRef.current || submittingRef.current || (!value.trim() && !images.length)) return;
    if (images.some(image => image.status !== "ready")) { toast.error(t("images.notReady")); return; }
    const submittedText = value;
    const submittedRevision = draft.revision;
    const submittedImages = [...images];
    const attachments = submittedImages.flatMap(image => image.attachment ? [{ ...image.attachment }] : []);
    const fingerprint = JSON.stringify([submittedText, attachments, references]);
    if (submissionRef.current?.fingerprint !== fingerprint) submissionRef.current = { fingerprint, id: crypto.randomUUID() };
    submittingRef.current = true;
    setSubmitting(true);
    closeMention();
    setToolsOpen(false);
    try {
      // New uploads travel only as staged identities; File[] is retained at
      // the parent boundary for legacy callers, never duplicated here.
      await onSubmit(submittedText, [], attachments, submissionRef.current.id);
      setDraft(current => current.revision === submittedRevision ? { value: "", revision: current.revision + 1 } : current);
      acceptImages(submittedImages);
      submissionRef.current = null;
    } catch {
      toast.error(t("images.sendFailed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    if (e.target === textareaRef.current) rememberSelection();
    setValue(next);
    if (queuedFilesRef.current.length && !composingRef.current) requestAnimationFrame(drainQueuedFiles);
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
      selectionRef.current = { start: range.start, end: range.start, direction: "none" };
    }
    if (mention.manual) {
      setMention((current) => ({ ...current, query: "" }));
    } else {
      closeMention();
      requestAnimationFrame(restoreSelection);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (composingRef.current || isImeKeyboardEvent(e.nativeEvent)) return;
    const intent = composerEnterIntent(e.nativeEvent, { enterBehavior, mentionOpen: mention.open });
    if (intent !== "native") {
      e.preventDefault();
      if (intent === "select-mention") {
        const item = catalog.items[catalog.activeIndex];
        if (item) selectDocument(item);
        return;
      }
      handleSubmit();
      return;
    }
    if (!mention.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      requestAnimationFrame(restoreSelection);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      catalog.setActiveIndex(nextDocumentMentionIndex(catalog.activeIndex, catalog.items.length, e.key));
    }
  };

  const addImageFiles = (files: File[]) => {
    if (composingRef.current) { queuedFilesRef.current.push(...files); return; }
    rememberSelection();
    const added = addFiles(files);
    if (!added.length) return;
    let next = textareaRef.current?.value ?? value;
    let caret = selectionRef.current.end;
    for (const image of added) {
      const insertion = insertImageMarker(next, caret, image.ordinal);
      next = insertion.text;
      caret = insertion.caret;
    }
    setValue(next);
    selectionRef.current = { start: caret, end: caret, direction: "none" };
    requestAnimationFrame(restoreSelection);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (!files.length) return;
    // Keep mixed text intact; consume image-only paste once, without a second
    // browser insertion of a filename or HTML clipboard representation.
    const text = event.clipboardData.getData("text/plain");
    if (!text) { event.preventDefault(); addImageFiles(files); }
    else { queuedFilesRef.current.push(...files); }
  };

  const drainQueuedFiles = () => {
    if (composingRef.current || !queuedFilesRef.current.length) return;
    const files = queuedFilesRef.current.splice(0);
    addImageFiles(files);
  };

  const selectImageMarker = () => {
    rememberSelection();
    const marker = selectedImageMarker(textareaRef.current?.value ?? value, selectionRef.current,
      images.map(image => ({ id: image.localClientId, ordinal: image.ordinal })));
    setSelectedPhoto(marker?.id);
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
    e.preventDefault();
    addImageFiles(Array.from(e.dataTransfer.files));
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
      ref={composerRef}
      data-manuscript-composer
      data-composer-state={composerState}
      data-panel-form={onPill ? "pill" : "manuscript"}
      data-editor-active={focused || toolsOpen || mention.open || isLoading ? "true" : "false"}
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
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
          setToolsOpen(false);
        }
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && toolsOpen && !composingRef.current && !isImeKeyboardEvent(event.nativeEvent)) {
          event.preventDefault();
          event.stopPropagation();
          setToolsOpen(false);
          toolsTriggerRef.current?.focus({ preventScroll: true });
        }
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
              onClose={() => { closeMention(); requestAnimationFrame(restoreSelection); }}
              onKeyDown={handleKeyDown}
            />
          </div>
        )}
        {images.length > 0 && (
          <div className="conversation-composer-attachments conversation-draft-photos" data-composer-attachments>
            <div className="conversation-image-stack" data-image-stack>
              {images.filter(image => image.status === "ready" && image.attachment).map((image, index, ready) => (
                <div key={image.localClientId} className="conversation-photo-seat" data-attachment-preview
                  data-photo-front={selectedPhoto === image.localClientId || (!selectedPhoto && index === ready.length - 1) || undefined}
                  style={{ "--photo-offset": index } as React.CSSProperties}>
                  <ImagePolaroid image={image.attachment!} animate selected={selectedPhoto === image.localClientId}
                    onSelect={() => { setSelectedPhoto(image.localClientId); photoRefs.current.get(image.localClientId)?.focus({ preventScroll: true }); }}
                    onRemove={() => removeImage(image.localClientId)}
                    figureRef={(node) => { if (node) photoRefs.current.set(image.localClientId, node); else photoRefs.current.delete(image.localClientId); }} />
                </div>
              ))}
            </div>
            {images.filter(image => image.status === "ready").length > 1 && <div className="conversation-photo-index" role="group" aria-label={t("images.attached")}>
              {images.filter(image => image.status === "ready").map(image => <button key={image.localClientId} type="button"
                aria-label={`${imageMarkerText(image.ordinal)} ${image.file.name}`} aria-pressed={selectedPhoto === image.localClientId}
                onClick={() => { setSelectedPhoto(image.localClientId); photoRefs.current.get(image.localClientId)?.focus({ preventScroll: true }); }}>{imageMarkerText(image.ordinal)}</button>)}
            </div>}
            <div aria-live="polite">
              {images.filter(image => image.status !== "ready").map(image => (
                <div key={image.localClientId} className="conversation-upload-status" data-upload-id={image.localClientId} data-upload-state={image.status}>
                  <span>{imageMarkerText(image.ordinal)} {image.file.name}: {t(image.status === "error" ? "images.failed" : image.status === "preparing" ? "images.preparing" : "images.uploading")}</span>
                  {image.error && <p>{image.error === "original-too-large" ? t("images.originalTooLarge") : image.error === "too-large" ? t("images.tooLarge") : image.error}</p>}
                  {image.status === "error" && <button type="button" onClick={() => retryImage(image.localClientId)}>{t("images.retry")}</button>}
                  <button type="button" onClick={() => removeImage(image.localClientId)} aria-label={t("removeAttachment", { name: image.file.name })}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {limitReached && <p className="conversation-upload-status" role="alert">{t("images.limit")}</p>}
        {removed && <p className="conversation-upload-status" role="status">{t("images.removed", { name: removed.file.name })} <button type="button" onClick={undoRemove}>{t("images.undo")}</button></p>}
        {submitting && <p className="conversation-upload-status" role="status">{t("images.submitting")}</p>}
        <div className="conversation-composer-draft">
          <textarea
            ref={textareaRef}
            data-manuscript-input
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={selectImageMarker}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; rememberSelection(); requestAnimationFrame(drainQueuedFiles); }}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            aria-describedby={`${toolsId}-hint`}
            aria-keyshortcuts={enterBehavior === "send" ? "Enter Control+Enter Meta+Enter" : "Control+Enter Meta+Enter"}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mention.open}
            aria-controls={mention.open ? `${mentionId}-listbox` : undefined}
            aria-activedescendant={mention.open && catalog.items[catalog.activeIndex] ? `${mentionId}-option-${catalog.activeIndex}` : undefined}
            rows={1}
            enterKeyHint={enterBehavior === "send" ? "send" : "enter"}
            className="w-full resize-none bg-transparent focus:outline-none"
          />
          <p className="conversation-upload-status" data-composer-keyboard-caption>{t(enterBehavior === "send" ? "keyboardSendCaption" : "keyboardCaption")}</p>
        </div>
      </div>

      <span id={`${toolsId}-hint`} className="sr-only">{t(enterBehavior === "send" ? "keyboardSendHint" : "keyboardHint")}</span>
      <div className="conversation-composer-toolbar" data-composer-mini-toolbar data-composer-floating-controls>
        <button
          ref={toolsTriggerRef}
          type="button"
          data-composer-tools-trigger
          className="conversation-control conversation-composer-tools-trigger"
          aria-label={t("tools")}
          aria-expanded={toolsOpen}
          aria-controls={toolsId}
          onPointerDown={rememberSelection}
          onClick={() => setToolsOpen((open) => !open)}
        >
          <Plus aria-hidden className="size-4" />
        </button>
        <div id={toolsId} className="conversation-composer-toolbar-left" data-composer-tools hidden={!onPill && !toolsOpen} role="group" aria-label={t("tools")}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-attach
                  onClick={() => { rememberSelection(); fileInputRef.current?.click(); }}
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
            disabled={!hasContent || submitting || images.some(image => image.status !== "ready")}
            aria-label={t("sendTooltip")}
            aria-keyshortcuts={enterBehavior === "send" ? "Enter Control+Enter Meta+Enter" : "Control+Enter Meta+Enter"}
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
