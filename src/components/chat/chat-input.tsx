"use client";

import { useState, useRef, useEffect, useLayoutEffect, useId, type FormEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, AtSign, Maximize2, Square, Paperclip, Radio, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ISLAND } from "@/components/layout/island";
import { requestCompanionPanelOpen } from "@/lib/chat/companion-panel";
import { appendNativeDraft, NATIVE_DRAFT_EVENT } from "@/lib/chat/native-draft";
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

/** The textarea's floor and ceiling, in px. The floor is what an empty
 *  composer reports so the box does not collapse while it is being typed
 *  into and back out of; the ceiling is where it starts scrolling instead of
 *  growing, so a pasted essay cannot push the toolbar off the screen. */
const TEXTAREA_MIN_PX = 44;
const TEXTAREA_MAX_PX = 160;

interface ChatInputProps {
  onSubmit: (message: string, images: File[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  // The fixed model and thinking profile are owned by the server.
  /**
   * The COMPACT form: one row of controls, no textarea, no attachments.
   *
   * This is the composer at a card rung, where the reader is looking at the
   * field and an empty box the size of a card would sit on top of it. What
   * survives the collapse is the control that restores the full composer.
   * The attach button does NOT survive: choosing a file is the first half of
   * sending, and a send button is not on screen either. Model selection does
   * not survive for the same reason — it is a setting for the next message,
   * and there is no next message to write yet. (The memory-docs button that
   * once survived here retired with v0.25b: the library's Dossier section is
   * the archive's only door.)
   *
   * (Fully latent: the card rungs that asked for this form retired with the
   * ladder — nothing renders the collapsed composer any more. The panel's
   * collapsed tier draws the PILL form instead.)
   *
   * The component stays MOUNTED across the forms (this is one component
   * with early returns, not several), so typed text and staged image
   * attachments survive a form change in every direction.
   */
  collapsed?: boolean;
  /** Restore the full composer. Required when `collapsed`. */
  onExpand?: () => void;
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
  collapsed = false,
  onExpand,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const tComposer = useTranslations("composer");
  const tPanel = useTranslations("conversationPanel");
  const tier = usePanelTier();
  const reducedMotion = useReducedMotion() ?? false;
  const mentionId = useId();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const miniInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [mention, setMention] = useState<{
    open: boolean;
    manual: boolean;
    query: string;
    range: DocumentMentionRange | null;
  }>({ open: false, manual: false, query: "", range: null });
  const { references, addReference, removeReference } = useDocumentContext();
  const persona = useNativePersona() ?? "user";
  const catalog = useDocumentMentionCatalog(mention.open, mention.query, persona);
  const { images, removeImage, clearImages, handlePaste, handleDrop, handleDragOver } = useImageAttachments();

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

  // Expanding the pill mounts a new textarea with the existing draft. Measure
  // after that DOM update as well as after typing, so wrapped text is visible.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${TEXTAREA_MIN_PX}px`;
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_PX) + "px";
  }, [value, tier?.mode]);

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
      requestAnimationFrame(() => {
        const target = tier?.mode === "pill" ? miniInputRef.current : textareaRef.current;
        target?.focus();
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isImeKeyboardEvent(e.nativeEvent)) return;
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
  const fade = reducedMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: "easeOut" as const };

  // ── THE COMPACT FORM ──────────────────────────────────────────────────────
  // One row, siblings throughout — because the control that restores the
  // composer stands where the send button stands, and everything beside it is
  // its peer rather than a subordinate. The arrow is last for the same reason
  // it is last in the full form: the right edge is where "do the thing" lives,
  // at both sizes, so the muscle memory carries across the collapse.
  if (collapsed) {
    return (
      <div
        data-composer-pill
        className={`${ISLAND} flex items-center gap-0.5 p-1`}
      >
        <button
          type="button"
          data-composer-collapsed
          aria-label={tComposer("open")}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          onClick={onExpand}
          className="flex h-9 items-center gap-2 px-2.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          {/* The hint leads, the arrow stays pinned to the right edge — so the
              button grows LEFTWARD and the target never moves out from under
              the pointer that is already on it. */}
          <motion.span
            initial={false}
            animate={{ opacity: hovered ? 1 : 0, width: hovered ? "auto" : 0 }}
            transition={fade}
            className="overflow-hidden text-xs whitespace-nowrap"
          >
            {tComposer("hint")}
          </motion.span>
          <ArrowUp className="size-4 shrink-0" />
        </button>
      </div>
    );
  }

  // ── THE PILL FORM (v0.13 §4) ─────────────────────────────────────────────
  // The conversation panel's collapsed tier: the floating glass pill's ONE
  // row. Reading order (the v0.21 composer ruling): the LEFT end holds the
  // two entries that lead away from the row — attach, and the evolution
  // stream's HQ panel; the single-line input takes the middle (no box of its
  // own; the pill's chrome is the container); the RIGHT end walks towards
  // the act — the fullscreen verb, and send/stop as the RIGHTMOST control,
  // the outer corner "do the thing" owns in every form. Attach reuses the
  // same `useImageAttachments` state as the full form (one component, early
  // returns — a draft or a staged image survives expanding to fullscreen
  // verbatim), and stop reuses the same `onStop` the full form's button
  // calls.
  if (tier?.mode === "pill") {
    return (
      <div className="relative min-w-0 flex-1">
        {!mention.open && <DocumentReferenceChips references={references} onRemove={removeReference} floating />}
        {mention.open && (
          <DocumentMentionPicker
            id={mentionId}
            query={mention.query}
            catalog={catalog}
            manual={mention.manual}
            floating
            onQueryChange={(query) => setMention((current) => ({ ...current, query }))}
            onSelect={selectDocument}
            onClose={closeMention}
            onKeyDown={handleKeyDown}
          />
        )}
        <div
          data-pill-composer
          onPaste={handlePaste}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className="flex h-full min-w-0 flex-1 items-center gap-0.5"
        >
          <button
            type="button"
            data-attach
            onClick={() => fileInputRef.current?.click()}
            aria-label={t("attach")}
            title={t("attach")}
            className="composer-cell text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
            accept="image/*"
          />
          <HQStreamButton
            className="composer-cell text-muted-foreground hover:text-foreground"
            iconClassName="size-4"
          />
          <button
            type="button"
            data-document-mention
            onClick={openManualMention}
            aria-label={t("references.open")}
            title={t("references.open")}
            aria-expanded={mention.open && mention.manual}
            aria-controls={mention.open ? `${mentionId}-listbox` : undefined}
            className="composer-cell text-muted-foreground hover:text-foreground"
          >
            <AtSign aria-hidden className="size-4" />
          </button>
          <input
            ref={miniInputRef}
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
            className="min-w-0 flex-1 bg-transparent px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            data-pill-expand
            onClick={() =>
              tier && tier.setMode(reducePanelMode(tier.mode, "toggleFullscreen"))
            }
            aria-label={tPanel("expand")}
            title={tPanel("expand")}
            className="composer-cell text-muted-foreground hover:text-foreground"
          >
            <Maximize2 className="size-4" />
          </button>
          {isLoading && onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label={t("stopTooltip")}
              title={t("stopTooltip")}
              className="composer-cell text-destructive hover:border-l-destructive hover:opacity-90"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          )}
          <button
            type="submit"
            onClick={(e) => handleSubmit(e as unknown as FormEvent)}
            disabled={!hasContent}
            aria-label={t("sendTooltip")}
            title={t("sendTooltip")}
            className={`composer-cell disabled:pointer-events-none disabled:opacity-30 ${
              hasContent
                ? "is-active hover:border-l-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`conversation-composer composer-bar relative overflow-hidden ${isDragOver ? "is-dragover" : ""}`}
      onPaste={handlePaste}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {references.length > 0 && (
        <div className="px-4 pt-3">
          <DocumentReferenceChips references={references} onRemove={removeReference} />
        </div>
      )}
      {mention.open && (
        <div className="px-4 pt-3">
          <DocumentMentionPicker
            id={mentionId}
            query={mention.query}
            catalog={catalog}
            manual={mention.manual}
            floating={false}
            onQueryChange={(query) => setMention((current) => ({ ...current, query }))}
            onSelect={selectDocument}
            onClose={closeMention}
            onKeyDown={handleKeyDown}
          />
        </div>
      )}
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-4 pt-3 flex-wrap">
          {images.map((file, i) => (
            <div key={i} className="relative group">
              <img
                src={URL.createObjectURL(file)}
                alt={file.name}
                className="h-16 w-16 rounded-lg border border-border object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                aria-label={t("removeAttachment", { name: file.name })}
                className="conversation-attachment-remove absolute -top-1.5 -right-1.5 h-6 w-6 bg-foreground text-background flex items-center justify-center"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The draft grows naturally above the controls. Both forms share
          the same translucent surface and persistent draft state. */}
      <div className="px-4 pb-2 pt-3">
        <textarea
          ref={textareaRef}
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
          className="min-h-11 max-h-40 w-full resize-none overflow-y-auto bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {/* Attachments, companion activity and sending stay below the draft. */}
      <div className="conversation-composer-toolbar">
        {/* Left side */}
        <div className="flex min-w-0 items-center gap-2">
          {/* Attach — always available. Present in the full form only; see the
              `collapsed` note above.

              This used to be disabled unless the selected model reported image
              support. That judgement was a hardcoded guess (providers do not
              report modalities, and the live catalog falls back to a per-provider
              default), so a model that gained vision was silently blocked from
              using it. Attaching is now never prevented; if a model genuinely
              cannot take the image, the provider says so and the turn surfaces
              that error rather than us pre-empting it. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-attach
                  onClick={() => fileInputRef.current?.click()}
                  // A tooltip is not an accessible name — it is a description
                  // that appears on hover, which a screen reader never does.
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

          {/* The evolution stream — opens the companion pod's HQ panel (the
              field↔HQ activity face). One panel, two doors: this button and
              the pod's floating one. */}
          <HQStreamButton
            className="conversation-control"
            iconClassName="h-3.5 w-3.5"
          />
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

        {/* Right side — stop, then send: the walk towards the act, so the
            send button keeps the outer corner it owns in every form. The
            tier verbs are NOT here: the pill form carries the expand (above)
            and the panel's slim bar carries the exit — a third mounted copy
            in this row duplicated the control (two buttons shared one
            aria-label, one of them zero-sized under the bar's `hidden`). */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Send / stop coexist mid-run (v0.30 §4.1): the stop key is the
              secondary, send keeps the outer corner and stays usable — the
              message queues into the live episode. */}
          {isLoading && onStop && (
            <button
              type="button"
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
