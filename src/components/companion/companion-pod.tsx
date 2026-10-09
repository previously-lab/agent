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
 * edge, 220px above the viewport foot + the safe-area inset. The pill (the
 * panel's collapsed tier) is a bottom-centre bar under ~70px, and the pod's
 * right-edge column never meets it. (An open composer's card can grow over
 * ~300px tall — chrome yields to an open composer.) 220 is a verified
 * constant, not a guess: the probe fails the build's geometry assertions if
 * any of the measured rects touch.
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
 * read-only instrumentation sections — the HQ activity face (the field↔HQ
 * channel made visible: last dispatch, run status, recent writes, read from
 * the memory/config/hq.json pointer via GET /api/evolution/hq-status and
 * POLLED ~3s while the panel is open — plus the LIVE beat log: the running
 * run's `data-hq-activity` frames, attached from the pointer's runId through
 * GET /api/evolution/hq/[runId]/stream. The stream replays, so a reload
 * simply re-attaches; while HQ works the button breathes, discovered by a
 * slow closed-panel poll) and a memory-map summary (slice/
 * active-slice overview fetched ONCE per panel open from the existing
 * episodic server actions, never polled, with a manual refresh). They ride
 * inside the scroll area under whatever the prose seat shows, and they are
 * why the button now always opens the panel — even with an empty seat the
 * internals are worth reaching.
 *
 * TWO ENTRIES, ONE PANEL: the composer's evolution-stream button asks this
 * pod to open via the companion-panel request bus
 * (`lib/chat/companion-panel.ts`); the panel itself is only ever drawn here.
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
import { subscribeCompanionPanelRequests } from "@/lib/chat/companion-panel";
import { fetchHQStatus, type HQStatus } from "@/lib/chat/hq-status";
import {
  clearStoredHQRunId,
  HQStreamError,
  streamHQActivity,
  writeStoredHQRunId,
  type HQActivityFrame,
} from "@/lib/chat/hq-stream";
import {
  getEpisodicState,
  getTimelineCatalog,
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

/** The HQ beat log is a glance, not an archive — the newest few frames only. */
const HQ_ACTIVITY_CAP = 20;
/** Closed-panel discovery: how often the pod checks for a NEW running HQ run. */
const HQ_DISCOVERY_POLL_MS = 15_000;

/** A finished narration kept for replay after the stream is dismissed. */
interface LatestNarration {
  text: string;
  timeLabel?: string;
}

/** The memory-map snapshot the debug block renders — one fetch per panel open. */
interface MemoryMapSnapshot {
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

/** How the last HQ run settled — the label row's value, localized. */
function hqRunStatusLabel(status: HQStatus, t: CompanionT): string {
  switch (status.runStatus) {
    case "running":
      return t("hqRunning");
    case "completed":
      return t("hqCompleted");
    case "idle":
      return t("hqIdle");
    case "failed":
      return t("hqFailed");
    default:
      return "—";
  }
}

/** HQ's own one-paragraph account rides wrote/idle frames — shown as a glance, capped. */
const HQ_NOTE_CAP = 160;

function capNote(note: string): string {
  const oneLine = note.trim().replace(/\s+/g, " ");
  return oneLine.length > HQ_NOTE_CAP
    ? `${oneLine.slice(0, HQ_NOTE_CAP)}…`
    : oneLine;
}

/**
 * One activity frame as a localized third-person line — the beat's KIND is
 * chrome (localized), its payloads (slice id, paths, HQ's note, the error)
 * stay raw. Never speech: HQ has no mouth, these are activity descriptions.
 */
function HQActivityLine({
  frame,
  t,
}: {
  frame: HQActivityFrame;
  t: CompanionT;
}) {
  let label: string;
  switch (frame.kind) {
    case "started":
      label = t("hqActStarted");
      break;
    case "reading":
      label = frame.sliceId
        ? t("hqActReadingSlice", { sliceId: frame.sliceId })
        : t("hqActReading");
      break;
    case "wrote":
      label = t("hqActWrote", { count: frame.paths?.length ?? 0 });
      break;
    case "idle":
      label = t("hqActIdle");
      break;
    case "failed":
      label = t("hqActFailed");
      break;
    case "finished":
      label = t("hqActFinished", {
        status:
          frame.status === "completed"
            ? t("hqCompleted")
            : frame.status === "failed"
              ? t("hqFailed")
              : t("hqIdle"),
      });
      break;
  }
  return (
    <li className="space-y-0.5">
      <div className="flex gap-2">
        <span className="min-w-0 break-words text-foreground/80">{label}</span>
      </div>
      {frame.kind === "wrote" && frame.paths && frame.paths.length > 0 && (
        <ul className="space-y-0.5">
          {frame.paths.slice(0, 4).map((path) => (
            <li key={path} className="break-all font-mono text-[10px]">
              {path}
            </li>
          ))}
        </ul>
      )}
      {frame.note && (
        <p className="break-words text-muted-foreground/70">{capNote(frame.note)}</p>
      )}
      {frame.error && (
        <p className="break-words text-muted-foreground/70">{capNote(frame.error)}</p>
      )}
    </li>
  );
}

/**
 * The HQ activity face — the field↔HQ channel made visible (v0.21 §5). HQ
 * works in its OWN durable run, so the session-local evolution bus can never
 * see it; this section reads the hq.json pointer instead: the field's last
 * dispatch (time + the brief's first line), whether HQ is running and how
 * its last run settled with how many briefs it handled, and the documents it
 * wrote most recently. Labels localized, values raw.
 *
 * On top of the pointer face sits the LIVE beat log (`activity`): the
 * run's own `data-hq-activity` frames, streamed from the durable run while
 * it works (and replayed whole on a re-attach). While attached, `live`
 * marks the section so the reader knows the beats are arriving in real
 * time; after the run packs up the frames stay as its account of itself.
 */
function HQStatusSection({
  hq,
  failed,
  t,
  locale,
  activity,
  live,
}: {
  hq: HQStatus | null;
  failed: boolean;
  t: CompanionT;
  locale: string;
  activity: HQActivityFrame[];
  live: boolean;
}) {
  const beats = activity.length > 0 && (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {live && (
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-[1px] bg-primary" />
        )}
        <span className="text-muted-foreground/70">
          {live ? t("hqLive") : t("hqActLog")}
        </span>
      </div>
      <ul className="space-y-1">
        {activity.map((frame, i) => (
          <HQActivityLine key={i} frame={frame} t={t} />
        ))}
      </ul>
    </div>
  );

  if (!hq && !failed) {
    return (
      <div className="space-y-1.5">
        {beats}
        <p className="text-muted-foreground/80">{t("hqLoading")}</p>
      </div>
    );
  }
  if (!hq) {
    return (
      <div className="space-y-1.5">
        {beats}
        <p className="text-muted-foreground/80">{t("hqFailedToLoad")}</p>
      </div>
    );
  }
  if (!hq.lastDispatchAt && !hq.runStatus) {
    return (
      <div className="space-y-1.5">
        {beats}
        <p className="text-muted-foreground/80">{t("hqEmpty")}</p>
      </div>
    );
  }

  const timeFmt = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const fmtTime = (iso: string | null): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : timeFmt.format(d);
  };
  const statusLabel = hqRunStatusLabel(hq, t);

  return (
    <div className="space-y-1.5">
      {beats}
      <DebugRow label={t("hqDispatch")} value={fmtTime(hq.lastDispatchAt)} mono />
      {hq.lastBriefPreview && (
        <p className="break-words text-foreground/70">{hq.lastBriefPreview}</p>
      )}
      <DebugRow
        label={t("hqStatus")}
        value={
          hq.runStatus === "running"
            ? `${statusLabel} · ${t("hqSince", { time: fmtTime(hq.runStartedAt) })}`
            : statusLabel
        }
      />
      <DebugRow label={t("hqBriefs")} value={String(hq.briefsHandled)} />
      {hq.recentWrites.length > 0 && (
        <div className="space-y-0.5">
          <span className="text-muted-foreground/70">{t("hqWrites")}</span>
          <ul className="space-y-0.5">
            {hq.recentWrites.slice(0, 5).map((path) => (
              <li key={path} className="break-all font-mono text-[10px]">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The read-only memory-map summary — slice/active-slice overview. */
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

  // ── Debug: the HQ activity face ───────────────────────────────────────────
  // HQ works in its own durable run, so the only honest read on it is the
  // hq.json pointer behind GET /api/evolution/hq-status. Fetched on open and
  // POLLED every 3s while the panel is open (a debug surface gets a poll, not
  // an SSE channel); closing the panel stops the clock. The seq guard drops
  // responses that land after a newer fetch started.
  const [hq, setHq] = useState<HQStatus | null>(null);
  const [hqFailed, setHqFailed] = useState(false);
  const hqSeqRef = useRef(0);
  const loadHQ = useCallback(async (): Promise<HQStatus | null> => {
    const seq = ++hqSeqRef.current;
    try {
      const res = await fetchHQStatus();
      if (seq !== hqSeqRef.current) return null;
      setHq(res.status);
      setHqFailed(false);
      return res.status;
    } catch {
      if (seq === hqSeqRef.current) setHqFailed(true);
      return null;
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    void loadHQ();
    const id = setInterval(() => void loadHQ(), 3000);
    return () => clearInterval(id);
  }, [open, loadHQ]);

  // ── HQ live: attach to the run's activity stream ──────────────────────────
  // The pointer names the running run (runId, written by the claiming run
  // itself); the run's durable stream REPLAYS, so "reconnect" is just
  // re-attaching — a reload's mount-time discovery below lands here. While
  // attached, frames drive everything (the beat log, the breathing button)
  // and no polling runs; the stream's own end (EOF after the run packs up,
  // or a 404 when the world forgot the run) is the detach signal.
  const [hqActivity, setHqActivity] = useState<HQActivityFrame[]>([]);
  const [hqLive, setHqLive] = useState(false);
  const hqAttachRef = useRef<{ runId: string; controller: AbortController } | null>(null);

  const detachHQ = useCallback(() => {
    hqAttachRef.current?.controller.abort();
    hqAttachRef.current = null;
    setHqLive(false);
  }, []);

  const attachHQ = useCallback(
    (runId: string) => {
      if (hqAttachRef.current?.runId === runId) return; // already on it
      detachHQ();
      const controller = new AbortController();
      hqAttachRef.current = { runId, controller };
      writeStoredHQRunId(runId);
      setHqActivity([]);
      setHqLive(true);
      streamHQActivity({ runId, signal: controller.signal }, (frame) => {
        if (hqAttachRef.current?.runId !== runId) return;
        setHqActivity((prev) => [...prev.slice(-(HQ_ACTIVITY_CAP - 1)), frame]);
      })
        .then(() => {
          if (hqAttachRef.current?.runId !== runId) return;
          // EOF — the run ended and its whole feed drained. The beats stay
          // on screen as the run's account of itself.
          hqAttachRef.current = null;
          setHqLive(false);
          clearStoredHQRunId();
          void loadHQ(); // settle the pointer face (runStatus just flipped)
        })
        .catch((e: unknown) => {
          if (hqAttachRef.current?.runId !== runId) return;
          hqAttachRef.current = null;
          setHqLive(false);
          // A gone run (404) invalidates the stash; a transport failure
          // keeps it — the discovery poll below re-attaches.
          if (e instanceof HQStreamError && e.code === "not_found") {
            clearStoredHQRunId();
          }
        });
    },
    [detachHQ, loadHQ],
  );

  // Discovery: the mount-time check IS the local reconnect (the stash only
  // hints; the pointer's runStatus + runId is the verdict — a stashed id the
  // pointer no longer names as running is simply not attached). Afterwards a
  // slow clock watches for NEW runs while the panel is closed — the pod
  // breathes for HQ even when nobody is looking at the internals.
  useEffect(() => {
    let stopped = false;
    const discover = async () => {
      if (stopped || hqAttachRef.current) return; // attached — frames drive
      const status = await loadHQ();
      if (stopped || !status) return;
      if (status.runStatus === "running" && status.runId) {
        attachHQ(status.runId);
      }
    };
    void discover();
    const id = setInterval(() => void discover(), HQ_DISCOVERY_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [loadHQ, attachHQ]);

  // Unmount: cut the attachment so a navigated-away pod leaves no reader.
  useEffect(() => detachHQ, [detachHQ]);

  // The composer's evolution-stream button is this panel's SECOND entry —
  // a request only ever opens; closing stays the panel's own gesture.
  useEffect(
    () => subscribeCompanionPanelRequests(() => setOpen(true)),
    [],
  );

  // ── Debug: the memory-map summary ─────────────────────────────────────────
  // Fetched ONCE per panel open from the existing episodic server actions —
  // never polled. Read-only; a manual refresh re-runs the same two reads
  // (useful right after an evolution run mutates the memory it summarizes).
  const [memoryMap, setMemoryMap] = useState<MemoryMapSnapshot | null>(null);
  const [memoryMapFailed, setMemoryMapFailed] = useState(false);
  const memoryMapSeqRef = useRef(0);
  const loadMemoryMap = useCallback(async () => {
    const seq = ++memoryMapSeqRef.current;
    const [episodic, catalog] = await Promise.all([
      getEpisodicState().catch(() => null),
      getTimelineCatalog().catch(() => null),
    ]);
    // A close/reopen superseded this read — its snapshot would be stale.
    if (seq !== memoryMapSeqRef.current) return;
    setMemoryMapFailed(!episodic && !catalog);
    setMemoryMap(
      episodic || catalog
        ? {
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
  const active = speaking || working || hqLive;
  const hasLiveTarget = target !== null;
  const headerTimeLabel = hasLiveTarget ? target?.timeLabel : latest?.timeLabel;
  /** An evolution run in flight or a completed one to replay — the panel's
      fallback seat when there is no narration at all. */
  const hasEvolution = Boolean(
    evolution && (evolution.working || evolution.latest),
  );

  const toggle = () => {
    // Debug phase: the button always opens the panel. Even with nothing in
    // the prose seat the two debug blocks below (HQ activity + memory map)
    // are worth reaching — the old "quiet pet does not perform an empty
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
      className="pointer-events-none fixed right-3 z-40 flex flex-col items-end sm:right-5 companion-pod-root"
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
                  prose seat above shows. Two read-only blocks: the HQ activity
                  face (polled while open), and a memory-map summary fetched
                  once per open. Raw values on purpose — this exists to make
                  internal state visible, not to be pretty. */}
              <div
                data-companion-pod-debug
                className="space-y-3 border-t border-foreground/10 px-4 py-3 font-sans text-[11px] leading-relaxed text-foreground/80"
              >
                <DebugSection
                  id="hq"
                  title={t("hqTitle")}
                  action={
                    <button
                      type="button"
                      onClick={() => void loadHQ()}
                      aria-label={t("debugRefresh")}
                      title={t("debugRefresh")}
                      className={`${ISLAND_CONTROL} size-5`}
                    >
                      <RefreshCw className="size-3" />
                    </button>
                  }
                >
                  <HQStatusSection
                    hq={hq}
                    failed={hqFailed}
                    t={t}
                    locale={locale}
                    activity={hqActivity}
                    live={hqLive}
                  />
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
