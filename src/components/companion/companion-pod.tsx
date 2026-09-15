"use client";

/**
 * CompanionPod — the companion stream's floating presence (v0.11).
 *
 * The pod is the physical embodiment of the companion/listener stream: a
 * quiet, desktop-pet-like button on the right edge that lives OUTSIDE the
 * conversation loop. It absorbed the narration dock's whole role — the
 * streaming effect, the serif prose panel, the error/retry contract all moved
 * here from the deleted `narration-dock.tsx`. The per-card 「讲讲这片」 entry
 * (`slice-narrate-button.tsx`) still originates a narration; the pod is where
 * it plays.
 *
 * PLACEMENT, MEASURED (scripts/probe-pod.mjs): the pod floats on the right
 * edge, 220px above the viewport foot + the safe-area inset. JumpControls'
 * stack (bottom-36/bottom-32 + two size-7 buttons + gap) tops out at ~206px on
 * a 390px phone and ~190px at ≥640px, so 220 clears both with margin; the
 * collapsed composer is a bottom-centre pill under ~70px, and the pod's
 * right-edge column never meets it. (An EXPANDED composer card can grow over
 * ~300px tall — JumpControls accept the same overlap; chrome yields to an
 * open composer.) 220 is a verified constant, not a guess: the probe fails
 * the build's geometry assertions if any of the measured rects touch.
 *
 * One narration at a time, unchanged: a new target (new `gen`) aborts the
 * previous reader, and dismissing an unfinished stream ends it. The button
 * click is NON-destructive — it only shows or hides the panel; the panel's ✕
 * is the "put it away" gesture the dock's ✕ was. A finished narration is kept
 * as the `latest` replay: dismiss it and the pod still remembers what
 * Previously last said — click to read it again. That is the whole "Previously
 * is here" idea: the pod is a presence, not a notification.
 *
 * States: idle (calm, muted) / speaking (narration in flight — a slow
 * breathing pulse + the brand-blue accent) / panel open. The activity state
 * is PROP-DRIVEN (`working`), not hard-wired to narration: the evolution
 * stream (a later task) gets a second event source that can light the same
 * button without a narration target.
 *
 * The pod renders in the SHELL (not the card field) so a narration survives
 * rung switches and view changes — the same ownership rule the dock had.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { AudioLines, CircleAlert, X } from "lucide-react";
import { ISLAND, ISLAND_CONTROL } from "@/components/layout/island";
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

/** A finished narration kept for replay after the stream is dismissed. */
interface LatestNarration {
  text: string;
  timeLabel?: string;
}

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

export function CompanionPod({
  target,
  onDismiss,
  onRetry,
  reducedMotion,
  working = false,
}: {
  target: NarrationTarget | null;
  /** End the narration and put the pod away (shell clears the target; the
      effect's cleanup aborts the reader). */
  onDismiss: () => void;
  /** Re-request a slice — a fresh gen, so it cancels whatever came before. */
  onRetry: NarrateRequest;
  reducedMotion: boolean;
  /**
   * A second event source (the evolution stream, wired later) can drive the
   * button's working state without a narration. `speaking || working` is what
   * the button breathes for.
   */
  working?: boolean;
}) {
  const t = useTranslations("companion");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<NarrationStatus>("connecting");
  const [text, setText] = useState("");
  const [error, setError] = useState<NarrateErrorCode | null>(null);
  const [latest, setLatest] = useState<LatestNarration | null>(null);
  /** Identifies the in-flight run; stale runs (new gen / unmount) are ignored. */
  const runRef = useRef(0);
  /** The last gen the pod auto-opened for — a fresh narration surfaces itself. */
  const seenGenRef = useRef(0);

  // The mouth stream itself — absorbed verbatim from the narration dock: one
  // reader at a time, a new target or an unmount aborts the old one.
  useEffect(() => {
    if (!target) return;
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
    return () => controller.abort();
  }, [target, locale]);

  // A new narration SURFACES ITSELF: the dock appeared when a target landed,
  // and the pod opening on a fresh gen is the same gesture. Collapsing the
  // panel afterwards is the reader's own business — the button only toggles.
  useEffect(() => {
    if (target && target.gen !== seenGenRef.current) {
      seenGenRef.current = target.gen;
      setOpen(true);
    }
  }, [target]);

  // A finished narration is remembered — dismissing the stream must not erase
  // what Previously just said; that is what makes the pod a presence.
  useEffect(() => {
    if (target && status === "done") {
      setLatest({ text, timeLabel: target.timeLabel });
    }
  }, [target, status, text]);

  const speaking =
    target !== null && (status === "connecting" || status === "streaming");
  const active = speaking || working;
  const hasLiveTarget = target !== null;
  const headerTimeLabel = hasLiveTarget ? target?.timeLabel : latest?.timeLabel;

  const toggle = () => {
    // Nothing to show yet: no live stream and no remembered one. The button
    // stays put — a quiet pet does not perform an empty trick.
    if (!hasLiveTarget && !latest) return;
    setOpen((o) => !o);
  };

  const closePanel = () => {
    if (hasLiveTarget) {
      // The dock's contract, kept: ✕ on a live (or finished) narration ends
      // it. Mid-stream, the shell clearing the target aborts the reader.
      onDismiss();
    } else {
      // ✕ on a replay forgets it for good.
      setLatest(null);
    }
    setOpen(false);
  };

  return (
    <div
      data-companion-pod-root
      className="pointer-events-none fixed right-3 z-40 flex flex-col items-end sm:right-5"
      style={{ bottom: "calc(220px + env(safe-area-inset-bottom, 0px))" }}
    >
      <button
        type="button"
        data-companion-pod
        data-active={active}
        aria-label={t("podLabel")}
        title={t("podLabel")}
        aria-expanded={open}
        onClick={toggle}
        className={`${ISLAND} pointer-events-auto flex size-10 items-center justify-center transition-colors ${
          active
            ? "text-primary"
            : open
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {/* The breathing pulse — the one accent the pod is allowed. A slow
            scale, not a badge or a face: presence, not alarm. */}
        <motion.span
          aria-hidden
          className="flex items-center justify-center"
          animate={
            active && !reducedMotion ? { scale: [1, 1.08, 1] } : { scale: 1 }
          }
          transition={
            active && !reducedMotion
              ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        >
          <AudioLines className="size-4" />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (hasLiveTarget || latest) && (
          <motion.aside
            key="companion-pod-panel"
            data-companion-pod-panel
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }
            }
            aria-label={t("dockLabel")}
            className="pointer-events-auto absolute right-0 bottom-full mb-2 flex max-h-[min(30rem,calc(100dvh-18rem))] w-[min(23rem,calc(100vw-2rem))] flex-col rounded-2xl bg-card/90 ring-1 ring-foreground/10 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.5)] backdrop-blur-md dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]"
          >
            {/* Chrome — sans, and it never scrolls away: the flex column caps
                the panel's height and the prose below takes the overflow. The
                dot is the state: pulsing while the mouth speaks, still on a
                replay, an alert mark when it could not. */}
            <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
              {hasLiveTarget && status === "error" ? (
                <CircleAlert aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
              ) : (
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-[1px] ${
                    active ? "bg-primary" : "bg-muted-foreground/50"
                  } ${speaking && !reducedMotion ? "animate-pulse" : ""}`}
                />
              )}
              {headerTimeLabel && (
                <span className="font-sans font-mono text-[10px] tabular-nums tracking-[0.08em] text-muted-foreground/70">
                  {headerTimeLabel}
                </span>
              )}
              <button
                type="button"
                onClick={closePanel}
                aria-label={t("close")}
                title={t("close")}
                className={`${ISLAND_CONTROL} ml-auto size-6`}
              >
                <X className="size-3.5" />
              </button>
            </div>

            {/* Prose — serif. Plain text, line breaks preserved; no markdown. */}
            <div className="min-h-0 overflow-y-auto">
              {target && status === "error" ? (
                <div className="px-4 pb-4 pt-2">
                  {/* A cut narration keeps the part that WAS told above the
                      error note — the stream's failure marker is stripped by
                      the helper, so `text` here is real prose only. */}
                  {text && (
                    <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
                      {text}
                    </p>
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
              ) : target && text ? (
                <div aria-live="polite" className="px-4 pb-4 pt-2">
                  <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
                    {text}
                    {speaking && (
                      <span aria-hidden className="animate-pulse text-primary/70">
                        ▍
                      </span>
                    )}
                  </p>
                </div>
              ) : target ? (
                /* No chunk yet — the thinking line reserves the body so the
                    card does not jump when the first words land. */
                <div className="px-4 pb-4 pt-2">
                  <p className="font-serif text-[13px] font-light italic leading-relaxed text-muted-foreground/80">
                    {t("thinking")}
                  </p>
                </div>
              ) : (
                /* The replay — what Previously last said, kept after the
                    stream was dismissed. Read-only: no caret, no retry. */
                <div aria-live="polite" className="px-4 pb-4 pt-2">
                  <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
                    {latest?.text}
                  </p>
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
