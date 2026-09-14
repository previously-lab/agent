"use client";

/**
 * NarrationDock — the floating panel for the "mouth" stream (让 Previously
 * 讲讲这片). One narration at a time: a new target (new `gen`) aborts the
 * previous reader, and dismissing the dock aborts the stream. The dock lives
 * in the shell, NOT in the card field, so narration keeps streaming while
 * the reader keeps browsing — scroll, zoom, rung switches and all.
 *
 * Visual language: the RunningCard / frosted-island family — sans chrome,
 * serif prose (v0.10: prose is serif, chrome is sans). The narration itself
 * is plain prose rendered as text with preserved line breaks — no markdown.
 *
 * States: connecting (request in flight, "Previously 正在回想…") → streaming
 * (typewriter-appended text, pulsing indicator + soft caret) → done → error
 * (localized copy; 429 is the gentle "enough for today", 501 the
 * shouldn't-happen-here fallback).
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { CircleAlert, X } from "lucide-react";
import { ISLAND_CONTROL } from "@/components/layout/island";
import {
  NarrateError,
  streamNarration,
  type NarrateErrorCode,
} from "@/lib/companion/narrate";

export interface NarrationTarget {
  sliceId: string;
  /** Pre-formatted timecode for the header — the card's own date + start. */
  timeLabel?: string;
  /** Bumped per request; a new gen supersedes (and aborts) the previous one. */
  gen: number;
}

export type NarrateRequest = (sliceId: string, timeLabel?: string) => void;

type NarrationStatus = "connecting" | "streaming" | "done" | "error";

/** Error codes map to localized, gentle copy; everything else is generic. */
function errorMessage(code: NarrateErrorCode, t: ReturnType<typeof useTranslations>): string {
  switch (code) {
    case "budget_exhausted":
      return t("errorBudget");
    case "unavailable":
      return t("errorUnavailable");
    default:
      return t("errorGeneric");
  }
}

export function NarrationDock({
  target,
  onClose,
  onRetry,
  reducedMotion,
  bottom,
}: {
  target: NarrationTarget;
  onClose: () => void;
  /** Re-request a slice — a fresh gen, so it cancels whatever came before. */
  onRetry: NarrateRequest;
  reducedMotion: boolean;
  /** px the dock floats above the pane's bottom edge (composer clearance). */
  bottom: number;
}) {
  const t = useTranslations("companion");
  const locale = useLocale();
  const [status, setStatus] = useState<NarrationStatus>("connecting");
  const [text, setText] = useState("");
  const [error, setError] = useState<NarrateErrorCode | null>(null);
  /** Identifies the in-flight run; stale runs (new gen / unmount) are ignored. */
  const runRef = useRef(0);

  useEffect(() => {
    const run = ++runRef.current;
    const controller = new AbortController();
    setStatus("connecting");
    setText("");
    setError(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    streamNarration(
      {
        sliceId: target.sliceId,
        locale,
        ...(timezone ? { timezone } : {}),
        signal: controller.signal,
      },
      (accumulated) => {
        if (run !== runRef.current) return;
        setText(accumulated);
        setStatus("streaming");
      },
    )
      .then(() => {
        if (run !== runRef.current) return;
        setStatus("done");
      })
      .catch((e: unknown) => {
        if (run !== runRef.current) return;
        if (controller.signal.aborted) return;
        setError(e instanceof NarrateError ? e.code : "request_failed");
        setStatus("error");
      });
    // A new target or an unmount aborts the old reader — one narration at a
    // time, and a dismissed dock is a narration ended.
    return () => controller.abort();
  }, [target, locale]);

  const streaming = status === "connecting" || status === "streaming";

  return (
    <motion.aside
      data-narration-dock
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      aria-label={t("dockLabel")}
      className="absolute right-3 z-30 w-[min(23rem,calc(100vw-2rem))] rounded-2xl bg-card/90 ring-1 ring-foreground/10 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.5)] backdrop-blur-md dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]"
      style={{ bottom }}
    >
      {/* Chrome — sans. The dot is the state: pulsing while the mouth
          speaks, still when it finishes, an alert mark when it could not. */}
      <div className="flex items-center gap-2 px-4 pt-3">
        {status === "error" ? (
          <CircleAlert aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
        ) : (
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-[1px] bg-primary ${
              streaming && !reducedMotion ? "animate-pulse" : ""
            }`}
          />
        )}
        {target.timeLabel && (
          <span className="font-sans font-mono text-[10px] tabular-nums tracking-[0.08em] text-muted-foreground/70">
            {target.timeLabel}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          title={t("close")}
          className={`${ISLAND_CONTROL} ml-auto size-6`}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Prose — serif. Plain text, line breaks preserved; no markdown. */}
      {status === "error" ? (
        <div className="px-4 pb-4 pt-2">
          {/* A cut narration keeps the part that WAS told above the error
              note — the stream's failure marker is stripped by the helper,
              so `text` here is real prose only. */}
          {text && (
            <div aria-live="polite" className="max-h-[30vh] overflow-y-auto">
              <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
                {text}
              </p>
            </div>
          )}
          <p
            className={`font-serif text-[13px] font-light leading-relaxed text-muted-foreground ${
              text ? "mt-2" : ""
            }`}
          >
            {error ? errorMessage(error, t) : t("errorGeneric")}
          </p>
          <button
            type="button"
            onClick={() => onRetry(target.sliceId, target.timeLabel)}
            className="mt-2 font-sans text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {t("retry")}
          </button>
        </div>
      ) : text ? (
        <div aria-live="polite" className="max-h-[38vh] overflow-y-auto px-4 pb-4 pt-2">
          <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
            {text}
            {streaming && (
              <span aria-hidden className="animate-pulse text-primary/70">
                ▍
              </span>
            )}
          </p>
        </div>
      ) : (
        /* No chunk yet — the thinking line reserves the body so the card
            does not jump when the first words land. */
        <div className="px-4 pb-4 pt-2">
          <p className="font-serif text-[13px] font-light italic leading-relaxed text-muted-foreground/80">
            {t("thinking")}
          </p>
        </div>
      )}
    </motion.aside>
  );
}
