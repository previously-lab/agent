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
 * States (v0.29 §4.5 — the name tab): idle (calm, ink) / working (narration
 * or evolution in flight — the word wears the live accent and types its own
 * ellipsis; the scale-breathing orb is retired) / unread (a narration or an
 * evolution completion arrived while the panel was shut — a folded corner,
 * the dog-ear) / error (the dog-ear carries an engraved exclamation — still
 * ink, never red). The activity state is PROP-DRIVEN (`working`), not
 * hard-wired to narration: the evolution stream is the second source — the
 * shell subscribes to the evolution-activity bus (`lib/chat/evolution-activity.ts`)
 * and passes the run's presence down, so the same tab works while Previously
 * evolves and the panel replays the newest completion when there is no
 * narration.
 *
 * DEBUG BLOCKS (dev phase): the panel's body ends with two additive,
 * read-only instrumentation sections — the HQ activity face (the field↔HQ
 * channel made visible: last dispatch, run status, recent writes, read from
 * the memory/config/hq.json pointer via GET /api/evolution/hq-status and
 * POLLED ~3s while the panel is open — plus the LIVE beat log: the running
 * run's `data-hq-activity` frames, attached from the pointer's runId through
 * GET /api/evolution/hq/[runId]/stream. The stream replays, so a reload
 * simply re-attaches; while HQ works the tab works, discovered by a slow
 * closed-panel poll) and a memory-map summary (slice/
 * active-slice overview fetched ONCE per panel open from the existing
 * episodic server actions, never polled, with a manual refresh). Since
 * v0.29 they ride behind a collapsed 「工作日志」 disclosure at the panel's
 * foot — diagnostic value kept, debug noise off the default face.
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
import { CircleAlert, RefreshCw, X } from "lucide-react";
import { ISLAND, ISLAND_CONTROL } from "@/components/layout/island";
import type { EvolutionPresence } from "@/lib/chat/evolution-activity";
import { subscribeCompanionPanelRequests } from "@/lib/chat/companion-panel";
import {
  cancelPanelRun,
  fetchHQStatus,
  type HQStatusResponse,
} from "@/lib/chat/hq-status";
import {
  layerDegradationNote,
  reflectionStopTier,
  resolveStopTargets,
  stopTiersFor,
  type StopTier,
} from "@/lib/chat/hq-panel";
import {
  clearStoredHQRunId,
  HQStreamError,
  streamHQActivity,
  writeStoredHQRunId,
  type HQActivityFrame,
} from "@/lib/chat/hq-stream";
import {
  getEpisodicState,
  getTimelineSkeleton,
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
              : frame.status === "retired"
                ? t("hqRetired")
                : t("hqIdle"),
      });
      break;
  }
  return (
    <li className="space-y-0.5">
      <div className="flex gap-2">
        <span className="min-w-0 break-words text-foreground/80">{label}</span>
      </div>
      {(frame.kind === "wrote" || frame.kind === "failed") &&
        frame.paths &&
        frame.paths.length > 0 && (
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
 * The HQ activity face — the reflection unit made visible (v0.21 §5; v0.30
 * §2.4). The unit works in its OWN durable run, so the session-local
 * evolution bus can never see it; this section reads the hq.json pointer
 * instead: when its last run started, whether it is running and how its last
 * run settled with how many rounds it handled, the documents it wrote most
 * recently, and the last substantive round's staged one-line note (the 暂存
 * the next turn carries). Labels localized, values raw.
 *
 * On top of the pointer face sits the LIVE beat log (`activity`): the
 * run's own `data-hq-activity` frames, streamed from the durable run while
 * it works (and replayed whole on a re-attach). While attached, `live`
 * marks the section so the reader knows the beats are arriving in real
 * time; after the run packs up the frames stay as its account of itself.
 */
/**
 * 一键停分档 (v0.40 §2.3): ONE click opens the tier menu — 停本轮 / 停这一批 /
 * 停后台反思 — each line naming its consequence. The tier with a real
 * consequence (interrupting an answer) asks for confirmation; the
 * consequence-free tiers (archiving / tidy-up) act on click, the tooltip
 * sentence carrying the cost. Execution rides the EXISTING cancel path
 * (POST /api/evolution/hq-status/cancel) — no new cancellation machinery.
 */
function StopMenu({
  tiers,
  onTier,
  t,
}: {
  tiers: StopTier[];
  onTier: (tier: StopTier) => void;
  t: CompanionT;
}) {
  const [open, setOpen] = useState(false);
  if (tiers.length === 0) return null;
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="shrink-0 text-muted-foreground/80 underline underline-offset-2"
      >
        {t("hqStop")}
      </button>
      {open && (
        <span className="absolute right-0 z-10 mt-1 block w-64 space-y-1 border border-paper-line bg-background p-2 shadow-sm">
          {tiers.map((tier) => (
            <span key={tier.tier} className="block">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onTier(tier);
                }}
                title={t(tier.consequenceKey)}
                className="block w-full text-left text-foreground/90 underline-offset-2 hover:underline"
              >
                {t(tier.labelKey)}
              </button>
              <span className="block text-[10px] leading-snug text-muted-foreground/70">
                {t(tier.consequenceKey)}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function HQStatusSection({
  data,
  failed,
  t,
  locale,
  activity,
  live,
  requestCancel,
}: {
  /** The three-layer aggregate (v0.39 §4.1) — null while loading. */
  data: HQStatusResponse | null;
  failed: boolean;
  t: CompanionT;
  locale: string;
  activity: HQActivityFrame[];
  live: boolean;
  /** Executes a tier's cancels through the existing endpoint, then re-reads. */
  requestCancel: (targets: string[]) => void;
}) {
  const beats = activity.length > 0 && (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {live && (
          <span aria-hidden className="chrome-live-dot size-1.5 shrink-0 animate-pulse rounded-[1px]" />
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

  if (!data && !failed) {
    return (
      <div className="space-y-1.5">
        {beats}
        <p className="text-muted-foreground/80">{t("hqLoading")}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-1.5">
        {beats}
        <p className="text-muted-foreground/80">{t("hqFailedToLoad")}</p>
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
  const fmtAge = (ms: number | null): string => {
    if (ms === null) return "—";
    const min = Math.floor(ms / 60_000);
    return min < 1 ? "<1m" : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`;
  };

  const { reflection, runs, log } = data;
  const newestRound = log.state === "live" ? log.recentRounds[0] : undefined;
  // §6 旁注: one 人话 line per layer whose READ failed — 事实空 earns none.
  const reflectionNoteKey = layerDegradationNote("reflection", data);
  const runsNoteKey = layerDegradationNote("runs", data);
  const logNoteKey = layerDegradationNote("log", data);

  return (
    <div className="space-y-1.5">
      {beats}
      {/* ── 公开层: the reflection unit through the hook channel ── */}
      {reflection.state === "live" ? (
        <>
          <DebugRow
            label={t("hqStatus")}
            value={`${reflection.status} · ${t("hqSince", { time: fmtTime(reflection.startedAt) })} · ${fmtAge(reflection.ageMs)}`}
          />
          {reflection.attributes.rounds !== undefined && (
            <DebugRow label={t("hqBriefs")} value={reflection.attributes.rounds} />
          )}
          {reflection.attributes.lastError && (
            <p className="break-words text-foreground/70">{reflection.attributes.lastError}</p>
          )}
          {reflection.attributes.tookOver && (
            <DebugRow label="⚠" value={t("hqTookOver")} />
          )}
          <StopMenu
            tiers={[reflectionStopTier()]}
            t={t}
            onTier={(tier) => {
              // §2.3 — 停反思不确认: no live consequence; the tooltip said it.
              const targets = resolveStopTargets(
                tier.tier,
                { runId: reflection.runId, status: reflection.status, role: "reflection", slice: null, turn: null, burst: null, ageMs: reflection.ageMs },
                [],
                reflection.runId,
              );
              requestCancel(targets);
            }}
          />
        </>
      ) : reflection.state === "none" ? (
        <p className="text-muted-foreground/80">{t("hqNobodyHome")}</p>
      ) : (
        <p className="break-words text-muted-foreground/80">
          {t("hqUnreachable", { reason: reflection.reason })}
          {/* §6 — 看不到 ≠ 没有: name the failed READ, never the empty fact */}
          {reflectionNoteKey && (
            <span className="block text-[10px] text-muted-foreground/60">
              {t(reflectionNoteKey)}
            </span>
          )}
        </p>
      )}
      {/* ── 日志层: the water level + the newest round's note (降级显式) ── */}
      {log.state === "live" ? (
        <>
          <DebugRow
            label={t("hqCursor")}
            value={log.cursor?.sliceId ?? t("hqCursorNone")}
            mono
          />
          {log.behind !== null && (
            <DebugRow label="…" value={t("hqBehind", { count: log.behind })} />
          )}
          {newestRound?.note && (
            <div className="space-y-0.5">
              <DebugRow label={t("hqNote")} value={fmtTime(newestRound.at)} mono />
              <p className="break-words text-foreground/70">{newestRound.note}</p>
            </div>
          )}
          {newestRound?.evolved && (
            <DebugRow label={t("hqEvolutionBeat")} value={newestRound.evolved} />
          )}
        </>
      ) : (
        <p className="break-words text-muted-foreground/80">
          {t("hqLogUnavailable", { reason: log.reason })}
          {logNoteKey && (
            <span className="block text-[10px] text-muted-foreground/60">
              {t(logNoteKey)}
            </span>
          )}
        </p>
      )}
      {/* ── 运行时层: the live-runs table (增强层 — 缺席显式降级) ── */}
      <div className="space-y-0.5">
        <span className="text-muted-foreground/70">{t("hqRuns")}</span>
        {runs.state === "live" ? (
          <ul className="space-y-0.5">
            {runs.live.map((r) => (
              <li key={r.runId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono text-[10px]">
                  {t("hqRunRow", {
                    role: r.role ?? "?",
                    page: r.slice ?? "—",
                    turn: r.turn ? ` · turn ${r.turn}` : "",
                    burst: r.burst ? ` · burst ${r.burst.slice(0, 8)}` : "",
                    age: fmtAge(r.ageMs),
                  })}
                </span>
                <StopMenu
                  tiers={stopTiersFor(r)}
                  t={t}
                  onTier={(tier) => {
                    // §2.3 — only interrupting an ANSWER confirms; the cost
                    // rides the consequence sentence.
                    if (
                      tier.confirm &&
                      typeof window !== "undefined" &&
                      !window.confirm(t(tier.consequenceKey))
                    ) {
                      return;
                    }
                    requestCancel(
                      resolveStopTargets(
                        tier.tier,
                        r,
                        runs.live,
                        reflection.state === "live" ? reflection.runId : null,
                      ),
                    );
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="break-words text-muted-foreground/70">
            {t("hqRunsUnavailable")}
            {runsNoteKey && (
              <span className="block text-[10px] text-muted-foreground/60">
                {t(runsNoteKey)}
              </span>
            )}
          </p>
        )}
      </div>
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
  const [hq, setHq] = useState<HQStatusResponse | null>(null);
  const [hqFailed, setHqFailed] = useState(false);
  const hqSeqRef = useRef(0);
  const loadHQ = useCallback(async (): Promise<HQStatusResponse | null> => {
    const seq = ++hqSeqRef.current;
    try {
      const res = await fetchHQStatus();
      if (seq !== hqSeqRef.current) return null;
      setHq(res);
      setHqFailed(false);
      return res;
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
      // v0.39 §4.1 — the PUBLIC layer (hook channel) is the verdict: a live
      // reflection run's id attaches; "none" is 无人在家, not an error.
      if (
        status.reflection.state === "live" &&
        (status.reflection.status === "running" || status.reflection.status === "pending")
      ) {
        attachHQ(status.reflection.runId);
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
    const [episodic, skeleton] = await Promise.all([
      getEpisodicState().catch(() => null),
      getTimelineSkeleton().catch(() => null),
    ]);
    // A close/reopen superseded this read — its snapshot would be stale.
    if (seq !== memoryMapSeqRef.current) return;
    setMemoryMapFailed(!episodic && !skeleton);
    setMemoryMap(
      episodic || skeleton
        ? {
            sliceCount: skeleton?.length ?? 0,
            latestSliceId: skeleton?.at(-1)?.id ?? null,
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
  // v0.39 §1 — roundActive retired with hq.json: round liveness is a
  // STREAM-side signal, so breathing follows the live attachment itself.
  const hqBreathing = hqLive;
  const active = speaking || working || hqBreathing;
  const hasLiveTarget = target !== null;
  /** A cut narration — the tab's corner mark is an engraved exclamation
      (still ink, never red). */
  const narrationError = hasLiveTarget && status === "error";
  /** An unread completion: a narration or an evolution event landed while
      the panel was shut. Opening the panel clears it — the dog-ear is a
      "there is something to read" mark, not a notification badge. */
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (status === "done" && !open) setUnread(true);
  }, [status, open]);
  useEffect(() => {
    if (evolution?.latest && !evolution.working && !open) setUnread(true);
  }, [evolution, open]);
  useEffect(() => {
    if (open) setUnread(false);
  }, [open]);
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
      className="pointer-events-none fixed right-2 z-40 flex flex-col items-end md:right-4 companion-pod-root"
    >
      <button
        type="button"
        data-companion-pod
        data-active={active}
        aria-label={t("podLabel")}
        title={t("podLabel")}
        aria-expanded={open}
        onClick={toggle}
        // The name tab (v0.29 §4.5): a matte square label engraved with
        // the companion's name — the desk plaque for "Previously is here",
        // not a breathing orb. working wears the live accent and types its
        // own ellipsis; unread folds the corner (the dog-ear); error keeps
        // the flap and engraves an exclamation. The scale-breathing pulse
        // is retired — presence is print, not performance.
        className={`${ISLAND} chrome-podtab pointer-events-auto ${
          active
            ? "is-working"
            : narrationError
              ? "is-error"
              : unread
                ? "is-unread"
                : ""
        }`}
      >
        {t("nameTab")}
        {active && (
          <span className="chrome-dots" aria-hidden="true">
            <span>·</span>
            <span>·</span>
            <span>·</span>
          </span>
        )}
        {narrationError && (
          <span className="chrome-podtab-mark" aria-hidden="true">
            !
          </span>
        )}
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
            // The panel is PAPER — it keeps the grain (the no-texture ruling
            // covers chrome; the sheet's own texture stays) — and square
            // (v0.29 §4.5), one contact shadow.
            className="chrome-panel-paper pointer-events-auto absolute right-0 bottom-full mb-2 flex max-h-[min(30rem,calc(100dvh-18rem))] w-[min(23rem,calc(100vw-2rem))] flex-col text-card-foreground"
          >
            {/* Chrome — sans, and it never scrolls away: the flex column caps
                the panel's height and the prose below takes the overflow. The
                dot is the state: the paper accent while the mouth speaks (the
                live state is the accent's meaning), still ink on a replay, an
                alert mark when it could not. */}
            <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
              {narrationError ? (
                <CircleAlert aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
              ) : (
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-[1px] ${
                    active ? "chrome-live-dot" : "bg-muted-foreground/50"
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
                      <span aria-hidden className="chrome-live animate-pulse">
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

              {/* v0.42 — the work log IS the panel's face, not a disclosure:
                  the reflection state, the live runs and the water level are
                  what the user opened this panel to see. Nothing here folds;
                  the data attributes stay for the probes. */}
              <div className="chrome-worklog">
                <div
                  data-companion-pod-debug
                  className="chrome-worklog-body space-y-3 font-sans text-[11px] leading-relaxed text-foreground/80"
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
                      data={hq}
                      failed={hqFailed}
                      t={t}
                      locale={locale}
                      activity={hqActivity}
                      live={hqLive}
                      requestCancel={(targets) => {
                        // §4.3/§2.3 — the panel's ONLY write, through the
                        // existing cancel endpoint; then re-read.
                        for (const runId of targets) {
                          void cancelPanelRun(runId);
                        }
                        void loadHQ();
                      }}
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
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
