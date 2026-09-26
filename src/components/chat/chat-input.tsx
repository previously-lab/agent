"use client";

import { useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Maximize2, Square, Paperclip, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModelSelector } from "./model-selector";
import { MemoryDocs } from "./memory-docs";
import { ISLAND } from "@/components/layout/island";
import { reducePanelMode, usePanelTier } from "./conversation-panel";

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
  /** Demo-mode persona — forwarded to the MemoryDocs server action. */
  persona?: string;
  // Model selection — owned by ChatPage so the request body and the toolbar
  // stay in sync. ChatInput renders the control, ChatPage persists.
  // Thinking is always ON at low effort (pinned server-side in start-turn.ts);
  // there is no thinking/effort UI anymore.
  currentModelId: string;
  onModelChange: (modelId: string) => void;
  /**
   * The COMPACT form: one row of controls, no textarea, no attachments.
   *
   * This is the composer at a card rung, where the reader is looking at the
   * field and an empty box the size of a card would sit on top of it. What
   * survives the collapse is what still makes sense from there — the memory
   * docs (reading them is not a conversation act) and the control that
   * restores the full composer. The attach button does NOT survive: choosing
   * a file is the first half of sending, and a send button is not on screen
   * either. Model selection does not survive for the same reason — it is a
   * setting for the next message, and there is no next message to write yet.
   *
   * (Latent in the conversation-panel surface: the shell pins the hosted
   * ChatPage's rung to "conversation", so the panel never asks for this
   * form. The panel's collapsed tier draws the PILL form instead.)
   *
   * The component stays MOUNTED across the forms (this is one component
   * with early returns, not several), so typed text and staged image
   * attachments survive a form change in every direction.
   */
  collapsed?: boolean;
  /** Restore the full composer. Required when `collapsed`. */
  onExpand?: () => void;
}

export function ChatInput({
  onSubmit,
  isLoading,
  onStop,
  persona,
  currentModelId,
  onModelChange,
  collapsed = false,
  onExpand,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const tComposer = useTranslations("composer");
  const tPanel = useTranslations("conversationPanel");
  const tier = usePanelTier();
  const reducedMotion = useReducedMotion() ?? false;
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { images, removeImage, clearImages, handlePaste, handleDrop, handleDragOver } = useImageAttachments();

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${TEXTAREA_MIN_PX}px`;
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_PX) + "px";
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    if (isLoading) return;

    onSubmit(trimmed, images);
    setValue("");
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = `${TEXTAREA_MIN_PX}px`;
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
        <MemoryDocs persona={persona} />

        <button
          type="button"
          data-composer-collapsed
          aria-label={tComposer("open")}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setHovered(true)}
          onBlur={() => setHovered(false)}
          onClick={onExpand}
          className="flex h-9 items-center gap-2 rounded-full px-2.5 text-muted-foreground transition-colors hover:text-foreground"
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
  // row, exactly the four controls the ruling allows — a round attach button
  // on the left, a single-line input in the middle (no box of its own; the
  // pill's chrome is the container), and round send/stop + fullscreen
  // buttons on the right. Attach reuses the same `useImageAttachments`
  // state as the full form (one component, early returns — a draft or a
  // staged image survives expanding to fullscreen verbatim), and stop
  // reuses the same `onStop` the full form's button calls.
  if (tier?.mode === "pill") {
    return (
      <div
        data-pill-composer
        onPaste={handlePaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        // flex-1: the row FILLS the glass host — it is a flex item of the
        // pill container, and without a grow rule it shrank to its content
        // width (buttons bunched left, a gutter on the right). min-w-0 lets
        // the input's own flex-1 take the slack and truncate honestly.
        className="flex h-full min-w-0 flex-1 items-center gap-0.5 px-2 sm:px-3"
      >
        {/* Attach — the full form's channel, nothing new: the hidden input
            below feeds the shared `handlePaste`, and the images reappear as
            previews the moment the reader expands. */}
        <button
          type="button"
          data-attach
          onClick={() => fileInputRef.current?.click()}
          aria-label={t("attach")}
          title={t("attach")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
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
        {/* The single line — a real one-line input, not a resized textarea.
            Enter sends, as in the full form. */}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          className="h-9 min-w-0 flex-1 bg-transparent font-serif text-sm text-foreground outline-none placeholder:font-serif placeholder:font-light placeholder:text-muted-foreground"
        />
        {/* Send / stop — one button, two faces, exactly like the full
            form's. */}
        {isLoading && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label={t("stopTooltip")}
            title={t("stopTooltip")}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            onClick={(e) => handleSubmit(e as unknown as FormEvent)}
            disabled={!hasContent}
            aria-label={t("sendTooltip")}
            title={t("sendTooltip")}
            className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
              hasContent
                ? "bg-brand text-white hover:bg-brand/90"
                : "bg-primary text-primary-foreground"
            }`}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
        {/* Expand — the pill's one way up, through the panel's own
            transition table. */}
        <button
          type="button"
          data-pill-expand
          onClick={() =>
            tier && tier.setMode(reducePanelMode(tier.mode, "toggleFullscreen"))
          }
          aria-label={tPanel("expand")}
          title={tPanel("expand")}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <Maximize2 className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-card ring-1 transition-[box-shadow,ring-color] duration-200 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)] ${
        isDragOver
          ? "ring-2 ring-blue-500/50"
          : "ring-foreground/10 focus-within:ring-foreground/30"
      }`}
      onPaste={handlePaste}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {/* Top light falloff — the same paper treatment as the timeline's
          frame card and the travel-clock card. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />
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

      {/* Row 1 — the writing surface. It is the taller of the two rows on
          purpose: at a card rung the composer is a floating card, and a card
          whose only generous dimension is its toolbar reads as a menu. */}
      <div className="px-4 pb-2 pt-3">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={t("placeholder")}
          rows={1}
          className="min-h-11 max-h-40 w-full resize-none overflow-y-auto bg-transparent font-serif text-sm text-foreground placeholder:font-serif placeholder:text-muted-foreground placeholder:font-light focus:outline-none"
        />
      </div>

      {/* Row 2 — everything you do AROUND the writing: what to attach, what to
          read, which model, and send. The zoom lens is deliberately NOT here;
          it moved to the shell's board bar, where it is mounted at every rung
          and can be reached without opening the composer at all. */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
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
                  className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-brand/10 transition-colors flex items-center justify-center"
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

          {/* Memory docs — previously / direction viewer. The one control that
              is in BOTH forms: reading the memory is not a conversation act,
              and gating it behind opening the composer would make the app's
              own record of itself the hardest thing in it to reach. */}
          <MemoryDocs persona={persona} />
        </div>

        {/* Right side — model then send, in that order, so the send button
            keeps the outer corner it owns in the compact form too. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <ModelSelector
            currentModelId={currentModelId}
            onModelChange={onModelChange}
          />
          {isLoading && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="h-8 w-8 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 flex items-center justify-center"
              title={t("stopTooltip")}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              onClick={(e) => handleSubmit(e as unknown as FormEvent)}
              disabled={!hasContent}
              className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-30 ${
                hasContent
                  ? "bg-brand text-white hover:bg-brand/90"
                  : "bg-primary text-primary-foreground"
              }`}
              title={t("sendTooltip")}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
