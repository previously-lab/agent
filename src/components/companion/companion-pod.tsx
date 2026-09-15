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
 * stream is the second source — the shell subscribes to the
 * evolution-activity bus (`lib/chat/evolution-activity.ts`) and passes the
 * run's presence down, so the same button breathes while Previously evolves
 * and the panel replays the newest completion when there is no narration.
 *
 * DEBUG BLOCKS (dev phase): the panel's body ends with two additive,
 * read-only instrumentation sections — the last evolution run's structured
 * detail (the full done-frame payload the bus now passes through) and a
 * memory-map summary (strand/slice/active-slice overview fetched ONCE per
 * panel open from the existing episodic server actions, never polled, with a
 * manual refresh). They ride inside the scroll area under whatever the prose
 * seat shows, and they are why the button now always opens the panel — even
 * with an empty seat the internals are worth reaching.
 *
 * The pod renders in the SHELL (not the card field) so a narration survives
 * rung switches and view changes — the same ownership rule the dock had.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLocale, useTranslations } from "next-intl";
import { AudioLines, CircleAlert, RefreshCw, X } from "lucide-react";
import { ISLAND, ISLAND_CONTROL } from "@/components/layout/island";
import type { EvolutionPresence } from "@/lib/chat/evolution-activity";
import {
  getEpisodicState,
  getStrandList,
  getTimelineCatalog,
  type StrandListItem,
} from "@/lib/episodic/actions";
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

/** The memory-map snapshot the debug block renders — one fetch per panel open. */
interface MemoryMapSnapshot {
  strandCount: number;
  /** The first few strands by most recent activity, with carrier counts. */
  topStrands: StrandListItem[];
  sliceCount: number;
  latestSliceId: string | null;
  activeSliceId: string | null;
  activeStatus: string | null;
}

type CompanionT = ReturnType<typeof useTranslations>;

/** Error codes map to localized, gentle copy; everything else is generic. */
function errorMessage(code: NarrateErrorCode, t: CompanionT): string {
  switch (code) {
    case "budget_exhausted":
      return t("errorBudget");
    case "unavailable":
      return t("errorUnavailable");
    default:
      return t("errorGeneric");
  }
}

/** One label/value row of a debug section — the label localized, the value raw. */
function DebugRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground/70">{label}</span>
      <span className={`min-w-0 break-words ${mono ? "font-mono text-[10px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/** A titled debug section with a shared data attribute for probing. */
function DebugSection({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-companion-pod-debug={id} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The last evolution run's structured detail — labels localized, values raw. */
function EvolutionDebugSection({
  latest,
  t,
}: {
  latest: EvolutionPresence["latest"];
  t: CompanionT;
}) {
  if (!latest) {
    return (
      <p className="text-muted-foreground/80">{t("debugEvolutionEmpty")}</p>
    );
  }
  const d = latest.detail;
  const status = latest.failed
    ? t("debugStatusFailed")
    : latest.hasChanges === false
      ? t("debugStatusNoChanges")
      : latest.hasChanges === true
        ? t("debugStatusChanged")
        : t("debugStatusUnknown");
  const directionOutcome = d?.direction
    ? (
        {
          no_change: t("debugDirectionNoChange"),
          updated: t("debugDirectionUpdated"),
          failed: t("debugDirectionFailed"),
          rejected: t("debugDirectionRejected"),
        } as const
      )[d.direction.outcome]
    : undefined;

  return (
    <div className="space-y-1.5">
      <DebugRow label={t("debugStatus")} value={status} />
      {latest.error && <DebugRow label={t("debugError")} value={latest.error} />}
      <DebugRow label={t("debugTurn")} value={latest.turnId} mono />
      {latest.summary?.trim() && (
        <DebugRow label={t("debugSummary")} value={latest.summary} />
      )}
      {d?.changes && (
        <DebugRow
          label={t("debugChangesLabel")}
          value={t("debugChanges", {
            added: d.changes.added,
            reinforced: d.changes.reinforced,
            demoted: d.changes.demoted,
            removed: d.changes.removed,
            superseded: d.changes.superseded,
          })}
        />
      )}
      {d?.partial && (
        <p className="text-amber-600 dark:text-amber-400">{t("debugPartial")}</p>
      )}
      {d?.direction && (
        <DebugRow
          label={t("debugDirection")}
          value={directionOutcome ?? d.direction.outcome}
        />
      )}
      {d?.direction?.summary?.trim() && (
        <p className="break-words">{d.direction.summary}</p>
      )}
      {d && d.triggers && d.triggers.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span className="shrink-0 text-muted-foreground/70">
            {t("debugTriggers")}
          </span>
          {d.triggers.map((trigger) => (
            <span key={trigger.bucket} className="font-mono text-[10px]">
              {`${trigger.bucket} ${trigger.score > 0 ? "+" : ""}${trigger.score}`}
            </span>
          ))}
        </div>
      )}
      {d && d.playbooks && d.playbooks.length > 0 && (
        <ul className="space-y-0.5">
          {d.playbooks.map((playbook, i) => (
            <li key={`${playbook.agent}-${i}`} className="break-words">
              <span className="font-mono text-[10px]">{playbook.agent}</span>
              {` — ${playbook.summary}`}
            </li>
          ))}
        </ul>
      )}
      {d && d.mutations && d.mutations.length > 0 && (
        <ul className="space-y-0.5">
          {d.mutations.map((mutation, i) => (
            <li key={i} className="flex gap-1.5">
              <span
                className={
                  mutation.type === "added"
                    ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                    : "shrink-0 text-red-500 dark:text-red-400"
                }
              >
                {mutation.type === "added"
                  ? t("debugMutationsAdded")
                  : t("debugMutationsRemoved")}
              </span>
              <span className="min-w-0 break-words">{mutation.text}</span>
            </li>
          ))}
        </ul>
      )}
      {d?.note?.trim() && <DebugRow label={t("debugNote")} value={d.note} />}
    </div>
  );
}

/** The read-only memory-map summary — strand/slice/active-slice overview. */
function MemoryDebugSection({
  memory,
  failed,
  t,
}: {
  memory: MemoryMapSnapshot | null;
  failed: boolean;
  t: CompanionT;
}) {
  return (
    <div className="space-y-1.5">
      {!memory && !failed && <p className="text-muted-foreground/80">{t("debugMemoryLoading")}</p>}
      {failed && !memory && (
        <p className="text-muted-foreground/80">{t("debugMemoryFailed")}</p>
      )}
      {memory && (
        <>
          <DebugRow
            label={t("debugStrands", { count: memory.strandCount })}
            value={
              memory.topStrands.length > 0
                ? memory.topStrands
                    .map((s) => `${s.name} ×${s.count}`)
                    .join("、")
                : "—"
            }
          />
          <DebugRow
            label={t("debugSlices", { count: memory.sliceCount })}
            value={memory.latestSliceId ?? "—"}
            mono
          />
          {memory.activeSliceId && (
            <DebugRow
              label={t("debugActiveSlice")}
              value={`${memory.activeSliceId} (${memory.activeStatus ?? "—"})`}
              mono
            />
          )}
          {!memory.activeSliceId && (
            <DebugRow label={t("debugActiveSlice")} value={t("debugNoActive")} />
          )}
        </>
      )}
    </div>
  );
}

export function CompanionPod({
  target,
  onDismiss,
  onRetry,
  reducedMotion,
  working = false,
  evolution,
}: {
  target: NarrationTarget | null;
  /** End the narration and put the pod away (shell clears the target; the
      effect's cleanup aborts the reader). */
  onDismiss: () => void;
  /** Re-request a slice — a fresh gen, so it cancels whatever came before. */
  onRetry: NarrateRequest;
  reducedMotion: boolean;
  /**
   * A second event source (the evolution stream, published by the chat page
   * onto the evolution-activity bus) drives the button's working state
   * without a narration. `speaking || working` is what the button breathes
   * for.
   */
  working?: boolean;
  /**
   * The evolution stream's presence, same source as `working` — while a run
   * is in flight the button breathes, and when the panel opens with no
   * narration to show, the latest evolution event takes the prose seat.
   * Absent entirely on the bridge brain (no inline evolution there).
   */
  evolution?: EvolutionPresence;
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

  // ── Debug: the memory-map summary ─────────────────────────────────────────
  // Fetched ONCE per panel open from the existing episodic server actions —
  // never polled. Read-only; a manual refresh re-runs the same three reads
  // (useful right after an evolution run mutates the memory it summarizes).
  const [memoryMap, setMemoryMap] = useState<MemoryMapSnapshot | null>(null);
  const [memoryMapFailed, setMemoryMapFailed] = useState(false);
  const memoryMapSeqRef = useRef(0);
  const loadMemoryMap = useCallback(async () => {
    const seq = ++memoryMapSeqRef.current;
    const [strands, episodic, catalog] = await Promise.all([
      getStrandList().catch(() => null),
      getEpisodicState().catch(() => null),
      getTimelineCatalog().catch(() => null),
    ]);
    // A close/reopen superseded this read — its snapshot would be stale.
    if (seq !== memoryMapSeqRef.current) return;
    setMemoryMapFailed(!strands && !episodic && !catalog);
    setMemoryMap(
      strands || episodic || catalog
        ? {
            strandCount: strands?.length ?? 0,
            topStrands: strands?.slice(0, 5) ?? [],
            sliceCount: catalog?.length ?? 0,
            latestSliceId: catalog?.at(-1)?.id ?? null,
            activeSliceId: episodic?.active?.slice_id ?? null,
            activeStatus: episodic?.active?.status ?? null,
          }
        : null,
    );
  }, []);
  useEffect(() => {
    if (open) void loadMemoryMap();
  }, [open, loadMemoryMap]);

  const speaking =
    target !== null && (status === "connecting" || status === "streaming");
  const active = speaking || working;
  const hasLiveTarget = target !== null;
  const headerTimeLabel = hasLiveTarget ? target?.timeLabel : latest?.timeLabel;
  /** An evolution run in flight or a completed one to replay — the panel's
      fallback seat when there is no narration at all. */
  const hasEvolution = Boolean(
    evolution && (evolution.working || evolution.latest),
  );

  const toggle = () => {
    // Debug phase: the button always opens the panel. Even with nothing in
    // the prose seat the two debug blocks below (evolution detail + memory
    // map) are worth reaching — the old "quiet pet does not perform an empty
    // trick" guard went when they arrived.
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
        {open && (
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
              ) : latest ? (
                /* The replay — what Previously last said, kept after the
                    stream was dismissed. Read-only: no caret, no retry. */
                <div aria-live="polite" className="px-4 pb-4 pt-2">
                  <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
                    {latest.text}
                  </p>
                </div>
              ) : hasEvolution ? (
                /* The evolution seat — no narration to show, so the pod
                    shares what it is doing to itself. Modest by design: a
                    status line while the run is in flight, then the run's
                    one-line account (or the generic fallback). ✕ just closes;
                    the event is presence, not a notification to dismiss. */
                <div aria-live="polite" className="px-4 pb-4 pt-2">
                  {evolution?.working ? (
                    <p className="font-serif text-[13px] font-light italic leading-relaxed text-muted-foreground/80">
                      {t("evolutionWorking")}
                    </p>
                  ) : evolution?.latest?.failed ? (
                    <p className="font-serif text-[13px] font-light leading-relaxed text-muted-foreground">
                      {t("evolutionFailed")}
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-foreground/90">
                      {evolution?.latest?.summary?.trim()
                        ? evolution.latest.summary
                        : t("evolvedFallback")}
                    </p>
                  )}
                </div>
              ) : null}

              {/* Debug instrumentation (dev phase) — additive to whatever the
                  prose seat above shows. Two read-only blocks: the last
                  evolution run's structured detail, and a memory-map summary
                  fetched once per open. Raw values on purpose — this exists
                  to make internal state visible, not to be pretty. */}
              <div
                data-companion-pod-debug
                className="space-y-3 border-t border-foreground/10 px-4 py-3 font-sans text-[11px] leading-relaxed text-foreground/80"
              >
                <DebugSection
                  id="evolution"
                  title={t("debugEvolutionTitle")}
                >
                  <EvolutionDebugSection latest={evolution?.latest ?? null} t={t} />
                </DebugSection>
                <DebugSection
                  id="memory"
                  title={t("debugMemoryTitle")}
                  action={
                    <button
                      type="button"
                      onClick={() => void loadMemoryMap()}
                      aria-label={t("debugRefresh")}
                      title={t("debugRefresh")}
                      className={`${ISLAND_CONTROL} size-5`}
                    >
                      <RefreshCw className="size-3" />
                    </button>
                  }
                >
                  <MemoryDebugSection
                    memory={memoryMap}
                    failed={memoryMapFailed}
                    t={t}
                  />
                </DebugSection>
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
