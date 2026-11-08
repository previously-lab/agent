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
 * any of the measured rects touch. In the narrow fullscreen manuscript the
 * dock moves into the lower safe area to clear the in-flow Send/Stop row.
 *
 * One narration at a time, unchanged: a new target (new `gen`) aborts the
 * previous reader, and dismissing an unfinished stream ends it. The button
 * click is NON-destructive — it only shows or hides the panel; the panel's ✕
 * is the "put it away" gesture the dock's ✕ was. A finished narration is kept
 * as the `latest` replay: dismiss it and the pod still remembers what
 * Previously last said — click to read it again. That is the whole "Previously
 * is here" idea: the pod is a presence, not a notification.
 *
 * The fixed task/workflow trigger shows idle, active, unread and error states
 * with standard shadcn/ui styling. The activity state is PROP-DRIVEN (`working`), not
 * hard-wired to narration: the evolution stream is the second source — the
 * shell subscribes to the evolution-activity bus (`lib/chat/evolution-activity.ts`)
 * and passes the run's presence down, so the same tab works while Previously
 * evolves and the panel replays the newest completion when there is no
 * narration.
 *
 * DEBUG BLOCKS (dev phase): the panel's body ends with two additive,
 * read-only instrumentation sections — the HQ activity face (the field↔HQ
 * channel made visible: last dispatch, run status, recent writes. v0.11
 * streams made it EVENT-DRIVEN: the status face (reflection + runs, zero
 * GitHub calls) polls ~3s while the panel is open; the log face (水位 /
 * recent archives) reads GET /api/evolution/hq-log ONLY on panel open, a
 * watched run's stream terminal (debounced 1s), or the manual refresh — the
 * live beats still ride the running run's `data-hq-activity` frames,
 * attached from the pointer's runId through
 * GET /api/evolution/hq/[runId]/stream; turn/summary runs get their own
 * terminal watchers on /api/chat/[runId]/stream) and a memory-map summary
 * (slice/ active-slice overview fetched ONCE per panel open from the
 * existing episodic server actions, never polled, with a manual refresh).
 * Since v0.29 they ride behind a collapsed 「工作日志」 disclosure at the
 * panel's foot — diagnostic value kept, debug noise off the default face.
 *
 * TWO ENTRIES, ONE PANEL: the composer's evolution-stream button asks this
 * pod to open via the companion-panel request bus
 * (`lib/chat/companion-panel.ts`); the panel itself is only ever drawn here.
 *
 * The pod renders in the SHELL (not the card field) so a narration survives
 * rung switches and view changes — the same ownership rule the dock had.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import { CircleAlert, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import styles from "./companion-pod.module.css";
import type { EvolutionPresence } from "@/lib/chat/evolution-activity";
import { subscribeCompanionPanelRequests } from "@/lib/chat/companion-panel";
import { createRunWatchers } from "@/lib/chat/run-watchers";
import {
  cancelPanelRun,
  fetchHQLog,
  fetchHQStatus,
  type HQLogLayer,
  type HQStatusResponse,
  type PanelRunRow,
} from "@/lib/chat/hq-status";
import {
  burstDisplaySuffix,
  createTerminalDebounce,
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
  watchChatRunEnd,
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
      <span className={`min-w-0 break-words ${mono ? "font-mono text-xs" : ""}`}>
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
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
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
 * One frame's localized kind label — shared by the beat line and (v0.43) the
 * reflection zone's live subtitle. The beat's KIND is chrome (localized),
 * its payloads (slice id, paths, HQ's note, the error) stay raw. Never
 * speech: HQ has no mouth, these are activity descriptions.
 */
function hqActivityLabel(frame: HQActivityFrame, t: CompanionT): string {
  switch (frame.kind) {
    case "started":
      return t("hqActStarted");
    case "reading":
      return frame.sliceId
        ? t("hqActReadingSlice", { sliceId: frame.sliceId })
        : t("hqActReading");
    case "wrote":
      return t("hqActWrote", { count: frame.paths?.length ?? 0 });
    case "idle":
      return t("hqActIdle");
    case "failed":
      return t("hqActFailed");
    case "finished":
      return t("hqActFinished", {
        status:
          frame.status === "completed"
            ? t("hqCompleted")
            : frame.status === "failed"
              ? t("hqFailed")
              : frame.status === "retired"
                ? t("hqRetired")
                : t("hqIdle"),
      });
  }
}

/** One activity frame as a localized third-person line in the beat log. */
function HQActivityLine({
  frame,
  t,
}: {
  frame: HQActivityFrame;
  t: CompanionT;
}) {
  const label = hqActivityLabel(frame, t);
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
            <li key={path} className="break-all font-mono text-xs">
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
  const [confirmationTier, setConfirmationTier] = useState<StopTier | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const pendingTierRef = useRef<StopTier | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const closeConfirmation = () => {
    pendingTierRef.current = null;
    setConfirmationOpen(false);
  };

  if (tiers.length === 0) return null;
  return (
    <Dialog
      open={confirmationOpen}
      onOpenChange={(open) => {
        if (!open) closeConfirmation();
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          render={
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto shrink-0 px-0 text-xs font-normal text-muted-foreground"
            />
          }
        >
          {t("hqStop")}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="w-64"
          finalFocus={() => pendingTierRef.current ? false : triggerRef.current}
        >
          {tiers.map((tier) => (
            <DropdownMenuItem
              key={tier.tier}
              onClick={() => {
                if (!tier.confirm) {
                  onTier(tier);
                  return;
                }
                pendingTierRef.current = tier;
                setConfirmationTier(tier);
                setConfirmationOpen(true);
              }}
              title={t(tier.consequenceKey)}
              className="flex-col items-start gap-0.5 whitespace-normal"
            >
              <span>{t(tier.labelKey)}</span>
              <span className="text-xs leading-snug text-muted-foreground">
                {t(tier.consequenceKey)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DialogContent
        showCloseButton={false}
        initialFocus={cancelRef}
        finalFocus={triggerRef}
      >
        <DialogHeader>
          <DialogTitle>{confirmationTier && t(confirmationTier.labelKey)}</DialogTitle>
          <DialogDescription>
            {confirmationTier && t(confirmationTier.consequenceKey)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button ref={cancelRef} type="button" variant="outline" />}>
            {t("hqStopCancel")}
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              // Consume before dispatch so repeated activation cannot send twice.
              const tier = pendingTierRef.current;
              if (!tier) return;
              closeConfirmation();
              onTier(tier);
            }}
          >
            {confirmationTier && t(confirmationTier.labelKey)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * v0.43 — the workflow panel (doc/design/v0.43-workflow-panel.md). Two tabs
 * under one segmented control:
 *   状态   — four zones: 正在对话 / 正在总结 / 正在反思 / 历史与水位. Each zone
 *          owns its EMPTY state (事实空) and its DEGRADED state (读取失败) —
 *          the two never mix (看不到 ≠ 没有).
 *   工作流 — the control-panel table: EVERY live run (role/slice/turn/burst +
 *          a per-second age), one 停 menu per row.
 * Live ages extrapolate from the poll's ageMs + asOf on the 1s local clock;
 * a row that just appeared slides in once (key-stable rows never re-animate).
 */

/** The 1s local clock — the engine behind live durations (panel open only). */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** One duration, human scale — "<1m" / "Nm" / "NhMm". */
function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const min = Math.floor(ms / 60_000);
  return min < 1 ? "<1m" : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`;
}

/** The registry's role → a localized label (an unattributed run reads 后台). */
function roleLabel(role: string | null, t: CompanionT): string {
  if (role === "turn") return t("wfRoleTurn");
  if (role === "summary") return t("wfRoleSummary");
  if (role === "reflection") return t("wfRoleReflection");
  return t("wfRoleOther");
}

/**
 * One live run as a control-panel row: the live status dot, the role +
 * slice/turn identity, a per-second age, and the 停 tier menu (absent for
 * rows that offer no tier — the menu renders nothing then).
 */
function RunRow({
  row,
  tickMs,
  t,
  onTier,
}: {
  row: PanelRunRow;
  /** ms elapsed since the poll that stamped ageMs — the local-clock push. */
  tickMs: number;
  t: CompanionT;
  onTier: (tier: StopTier, row: PanelRunRow) => void;
}) {
  const ageMs = row.ageMs === null ? null : row.ageMs + tickMs;
  return (
    <li className="flex items-center gap-2 bg-muted/50 px-2.5 py-2">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-sm bg-brand"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-xs font-medium text-foreground/90">
            {roleLabel(row.role, t)}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.slice ?? "—"}
            {row.turn ? ` · ${row.turn}` : ""}
          </span>
        </div>
        {(row.status !== "running" || row.burst) && (
          <div className="font-mono text-xs text-muted-foreground/70">
            {row.status}
            {row.burst ? ` · ${t("hqRunRowBurst", { suffix: burstDisplaySuffix(row.burst) })}` : ""}
          </div>
        )}
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {fmtDuration(ageMs)}
      </span>
      <StopMenu
        tiers={stopTiersFor(row)}
        t={t}
        onTier={(tier) => onTier(tier, row)}
      />
    </li>
  );
}

/** A zone's degraded line — the layer's 人话 + the 看不到 ≠ 没有 note.
 *  The raw server reason never renders in the panel (it is English); it
 *  rides the title tooltip so a curious reader can still see it. */
function DegradedLine({ text, noteKey, detail, t }: { text: string; noteKey: string | null; detail?: string | null; t: CompanionT }) {
  return (
    <p className="break-words text-muted-foreground/80" title={detail ?? undefined}>
      {text}
      {noteKey && (
        <span className="block text-xs text-muted-foreground/60">{t(noteKey)}</span>
      )}
    </p>
  );
}

/**
 * The tabbed workflow panel's body. Owns the tab state, the 1s clock, and
 * the tier→cancel binding; the zones read straight off the aggregate.
 */
function WorklogTabs({
  data,
  failed,
  log,
  logFailed,
  t,
  locale,
  activity,
  open,
  requestCancel,
}: {
  /** The two-layer status (v0.11 streams: reflection + runs) — null while loading. */
  data: HQStatusResponse | null;
  failed: boolean;
  /** The log layer, fetched separately (open / run-terminal / manual). */
  log: HQLogLayer | null;
  logFailed: boolean;
  t: CompanionT;
  locale: string;
  activity: HQActivityFrame[];
  open: boolean;
  /** Executes a tier's cancels through the existing endpoint, then re-reads. */
  requestCancel: (targets: string[]) => void;
}) {
  const nowMs = useNowTick(open);

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

  if (!data && !failed) {
    return (
      <div className="space-y-1.5">
        <p className="text-muted-foreground/80">{t("hqLoading")}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-1.5">
        <p className="text-muted-foreground/80">{t("hqFailedToLoad")}</p>
      </div>
    );
  }

  const asOfMs = Date.parse(data.asOf);
  const tickMs = Number.isNaN(asOfMs) ? 0 : Math.max(0, nowMs - asOfMs);
  const { reflection, runs } = data;
  // §6 旁注: one 人话 line per layer whose READ failed — 事实空 earns none.
  // v0.11 streams: the log layer arrives separately — a null log is "not
  // loaded yet" (no note), logFailed is its offline read.
  const reflectionNoteKey = layerDegradationNote("reflection", data);
  const runsNoteKey = layerDegradationNote("runs", data);
  const logNoteKey = logFailed
    ? "hqNoteOffline"
    : layerDegradationNote("log", { ...data, log: log ?? undefined });

  const allRows = runs.state === "live" ? runs.live : [];
  const reflectionRunId = reflection.state === "live" ? reflection.runId : null;

  /** StopMenu confirms disruptive tiers before reaching the existing cancel path. */
  const handleTier = (tier: StopTier, row: PanelRunRow) => {
    requestCancel(resolveStopTargets(tier.tier, row, allRows, reflectionRunId));
  };

  const runList = (rows: PanelRunRow[]) => (
    <ul className="space-y-1">
      {rows.map((r) => (
        <RunRow key={r.runId} row={r} tickMs={tickMs} t={t} onTier={handleTier} />
      ))}
    </ul>
  );

  const turnRows = allRows.filter((r) => r.role === "turn");
  const summaryRows = allRows.filter((r) => r.role === "summary");
  const latestBeat = activity.at(-1) ?? null;
  const recentBeats = activity.slice(-4).reverse();
  const newestRound = log?.state === "live" ? log.recentRounds[0] : undefined;

  return (
    <Tabs defaultValue="status" className="gap-3">
      <TabsList
        aria-label={t("wfTabsLabel")}
        className="sticky top-0 z-10 grid w-full grid-cols-2"
      >
        <TabsTrigger value="status" className="text-xs">
          {t("wfTabStatus")}
        </TabsTrigger>
        <TabsTrigger value="workflows" className="text-xs">
          {t("wfTabWorkflows")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="status" className="space-y-4">
            {/* ── 正在对话 ── */}
            <DebugSection id="talking" title={t("wfTalking")}>
              {runs.state === "live" ? (
                turnRows.length > 0 ? (
                  runList(turnRows)
                ) : (
                  <p className="text-muted-foreground/80">{t("wfTalkingEmpty")}</p>
                )
              ) : (
                <DegradedLine text={t("hqRunsUnavailable")} noteKey={runsNoteKey} t={t} />
              )}
            </DebugSection>

            {/* ── 正在总结 ── */}
            <DebugSection id="summarizing" title={t("wfSummarizing")}>
              {runs.state === "live" ? (
                summaryRows.length > 0 ? (
                  runList(summaryRows)
                ) : (
                  <p className="text-muted-foreground/80">{t("wfSummarizingEmpty")}</p>
                )
              ) : (
                <DegradedLine text={t("hqRunsUnavailable")} noteKey={runsNoteKey} t={t} />
              )}
              {log?.state === "live" && log.recentSummaries[0] && (
                <p className="font-mono text-xs text-muted-foreground/70">
                  {t("wfLastArchive", {
                    page: log.recentSummaries[0].slice,
                    time: fmtTime(log.recentSummaries[0].at),
                  })}
                </p>
              )}
            </DebugSection>

            {/* ── 正在反思: the reflection unit + its live activity stream ── */}
            <DebugSection id="reflection" title={t("wfReflecting")}>
              {reflection.state === "live" ? (
                <div className="space-y-1.5">
                  <DebugRow
                    label={t("hqStatus")}
                    value={`${reflection.status} · ${t("hqSince", { time: fmtTime(reflection.startedAt) })} · ${fmtDuration(reflection.ageMs === null ? null : reflection.ageMs + tickMs)}`}
                  />
                  {/* The live beat rides the subtitle seat — the newest frame
                      crossfades in (keyed), the run's own words over the poll. */}
                  {latestBeat && (
                    <p key={`${latestBeat.kind}-${latestBeat.at}`} className="text-xs text-foreground/80">
                      {hqActivityLabel(latestBeat, t)}
                    </p>
                  )}
                  {reflection.attributes.rounds !== undefined && (
                    <p className="text-xs text-foreground/80">
                      {t("wfRoundsDone", { count: reflection.attributes.rounds })}
                    </p>
                  )}
                  {reflection.attributes.lastError && (
                    <p className="break-words text-foreground/70">{reflection.attributes.lastError}</p>
                  )}
                  {reflection.attributes.tookOver && (
                    <DebugRow label="⚠" value={t("hqTookOver")} />
                  )}
                  {recentBeats.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-muted-foreground/70">{t("wfRecentBeats")}</span>
                      <ul className="space-y-1">
                        {recentBeats.map((frame, i) => (
                          <HQActivityLine key={`${frame.at}-${i}`} frame={frame} t={t} />
                        ))}
                      </ul>
                    </div>
                  )}
                  <StopMenu
                    tiers={[reflectionStopTier()]}
                    t={t}
                    onTier={(tier) => {
                      // §2.3 — 停反思不确认: no live consequence.
                      handleTier(
                        tier,
                        { runId: reflection.runId, status: reflection.status, role: "reflection", slice: null, turn: null, burst: null, ageMs: reflection.ageMs },
                      );
                    }}
                  />
                </div>
              ) : reflection.state === "none" ? (
                <p className="text-muted-foreground/80">{t("hqNobodyHome")}</p>
              ) : (
                <DegradedLine
                  text={t("hqUnreachable")}
                  noteKey={reflectionNoteKey}
                  detail={reflection.reason}
                  t={t}
                />
              )}
            </DebugSection>

            {/* ── 历史与水位: the water level + recent archives ── */}
            <DebugSection id="history" title={t("wfHistory")}>
              {log === null && !logFailed ? (
                <p className="text-muted-foreground/80">{t("hqLoading")}</p>
              ) : log?.state === "live" ? (
                <div className="space-y-1.5">
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
                  {!log.summariesAvailable ? (
                    <DegradedLine text={t("wfSummariesDown")} noteKey={null} t={t} />
                  ) : (
                    log.recentSummaries.length > 0 && (
                      <ul className="space-y-1">
                        {log.recentSummaries.slice(0, 3).map((s) => (
                          <li
                            key={`${s.slice}-${s.at ?? ""}`}
                            className="space-y-0.5 bg-muted/50 px-2.5 py-2"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate font-mono text-xs">{s.slice}</span>
                              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                {fmtTime(s.at)}
                              </span>
                            </div>
                            <p className="text-xs text-foreground/80">
                              {t("wfSummaryLanded", {
                                turns: s.userTurns,
                                replies: s.replies,
                                merges: s.merges,
                              })}
                            </p>
                            {s.failed.length > 0 && (
                              <div className="space-y-0.5">
                                {s.failed.map((f) => (
                                  <p key={f.turn} className="text-xs text-muted-foreground/80">
                                    {t("wfFailedNote", { turn: f.turn, status: f.status })}
                                  </p>
                                ))}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )
                  )}
                </div>
              ) : (
                <DegradedLine
                  text={t("hqLogUnavailable")}
                  noteKey={logNoteKey}
                  detail={log?.reason}
                  t={t}
                />
              )}
            </DebugSection>
      </TabsContent>
      <TabsContent value="workflows">
        {/* The control panel: every live run in one table. */}
        <DebugSection id="workflows" title={t("wfTabWorkflows")}>
            {runs.state === "live" ? (
              allRows.length > 0 ? (
                <>
                  <p className="font-mono text-xs tabular-nums text-muted-foreground/70">
                    {t("wfRunCount", { count: allRows.length })}
                  </p>
                  {runList(allRows)}
                </>
              ) : (
                <p className="text-muted-foreground/80">{t("wfEmptyRuns")}</p>
              )
            ) : (
              <DegradedLine text={t("hqRunsUnavailable")} noteKey={runsNoteKey} t={t} />
            )}
        </DebugSection>
      </TabsContent>
    </Tabs>
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

function CompanionPodBody({
  target,
  onDismiss,
  onRetry,
  working = false,
  evolution,
}: {
  target: NarrationTarget | null;
  /** End the narration and put the pod away (shell clears the target; the
      effect's cleanup aborts the reader). */
  onDismiss: () => void;
  /** Re-request a slice — a fresh gen, so it cancels whatever came before. */
  onRetry: NarrateRequest;
  /**
   * A second event source (the evolution stream, published by the chat page
   * onto the evolution-activity bus) drives the button's working state
   * without a narration. `speaking || working` marks the button active
   * for.
   */
  working?: boolean;
  /**
   * The evolution stream's presence, same source as `working` — while a run
   * is in flight the button is active, and when the panel opens with no
   * narration to show, the latest evolution event takes the prose seat.
   * Absent entirely on the bridge brain (no inline evolution there).
   */
  evolution?: EvolutionPresence;
}) {
  const t = useTranslations("companion");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
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
  // v0.11 streams — EVENT-DRIVEN, no GitHub polling:
  //   status (reflection + runs, ZERO GitHub calls): first open + every 3s —
  //     the live status clock; also what closed-panel discovery reads.
  //   log (水位 / rounds / archives, the GitHub read): first open + a watched
  //     run's stream terminal (debounced 1s across simultaneous finishes) +
  //     the manual refresh — never on the 3s clock.
  // The seq guards drop responses that land after a newer fetch started.
  const [hq, setHq] = useState<HQStatusResponse | null>(null);
  const [hqFailed, setHqFailed] = useState(false);
  const hqSeqRef = useRef(0);
  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<HQStatusResponse | null> => {
    const seq = ++hqSeqRef.current;
    try {
      const res = await fetchHQStatus(signal);
      if (signal?.aborted || document.visibilityState === "hidden" || seq !== hqSeqRef.current) return null;
      setHq(res);
      setHqFailed(false);
      return res;
    } catch {
      if (!signal?.aborted && seq === hqSeqRef.current) setHqFailed(true);
      return null;
    }
  }, []);
  const [hqLog, setHqLog] = useState<HQLogLayer | null>(null);
  const [hqLogFailed, setHqLogFailed] = useState(false);
  const hqLogSeqRef = useRef(0);
  const logAbortRef = useRef<AbortController | null>(null);
  const loadLog = useCallback(async (): Promise<HQLogLayer | null> => {
    if (document.visibilityState === "hidden") return null;
    logAbortRef.current?.abort();
    const controller = new AbortController();
    logAbortRef.current = controller;
    const seq = ++hqLogSeqRef.current;
    try {
      const res = await fetchHQLog(controller.signal);
      if (controller.signal.aborted || seq !== hqLogSeqRef.current) return null;
      setHqLog(res.log);
      setHqLogFailed(false);
      return res.log;
    } catch {
      if (!controller.signal.aborted && seq === hqLogSeqRef.current) setHqLogFailed(true);
      return null;
    }
  }, []);
  /** Run terminals within 1s of each other collapse into ONE log refresh. */
  const scheduleLogRefresh = useMemo(
    () => createTerminalDebounce(() => void loadLog(), 1_000),
    [loadLog],
  );
  useEffect(() => {
    if (!open || !visible) return;
    void loadLog();
  }, [open, visible, loadLog]);
  useEffect(() => {
    if (visible) return;
    scheduleLogRefresh.cancel();
    logAbortRef.current?.abort();
  }, [visible, scheduleLogRefresh]);

  // ── HQ live: attach to the run's activity stream ──────────────────────────
  // The pointer names the running run (runId, written by the claiming run
  // itself); the run's durable stream REPLAYS, so "reconnect" is just
  // re-attaching — a reload's mount-time discovery below lands here. While
  // attached, frames drive everything (the beat log and the active button)
  // and no polling runs; the stream's own end (EOF after the run packs up,
  // or a 404 when the world forgot the run) is the detach signal.
  const [hqActivity, setHqActivity] = useState<HQActivityFrame[]>([]);
  const [hqLive, setHqLive] = useState(false);
  const hqAttachRef = useRef<{ runId: string; controller: AbortController } | null>(null);
  // Frames already applied for the current run id. A re-attach replays the
  // durable feed from index 0; the reader skips this many replayed frames
  // so history is not applied twice. Cleared when the run ends or is gone.
  const hqAppliedRef = useRef<{ runId: string; count: number } | null>(null);
  const hqFinishedRef = useRef(new Set<string>());
  const hqRetryRef = useRef(new Map<string, { attempts: number; after: number }>());

  const detachHQ = useCallback(() => {
    hqAttachRef.current?.controller.abort();
    hqAttachRef.current = null;
    setHqLive(false);
  }, []);

  const attachHQ = useCallback(
    (runId: string) => {
      if (hqAttachRef.current?.runId === runId) return; // already on it
      if (hqFinishedRef.current.has(runId) || (hqRetryRef.current.get(runId)?.after ?? 0) > Date.now()) return;
      let applied = hqAppliedRef.current;
      if (applied?.runId !== runId) {
        // A different run — its history starts from an empty beat log.
        applied = { runId, count: 0 };
        hqAppliedRef.current = applied;
        setHqActivity([]);
      }
      detachHQ();
      const controller = new AbortController();
      hqAttachRef.current = { runId, controller };
      writeStoredHQRunId(runId);
      setHqLive(true);
      streamHQActivity(
        { runId, signal: controller.signal, skip: applied.count },
        (frame) => {
          if (hqAttachRef.current?.controller !== controller) return;
          hqRetryRef.current.delete(runId);
          applied.count += 1;
          setHqActivity((prev) => [...prev.slice(-(HQ_ACTIVITY_CAP - 1)), frame]);
        },
      )
        .then((result) => {
          if (hqAttachRef.current?.controller !== controller) return;
          // EOF — the run ended and its whole feed drained. The beats stay
          // on screen as the run's account of itself.
          hqAttachRef.current = null;
          setHqLive(false);
          if (result.kind !== "terminal") {
            const attempts = (hqRetryRef.current.get(runId)?.attempts ?? 0) + 1;
            hqRetryRef.current.set(runId, { attempts, after: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)) });
            return;
          }
          hqAppliedRef.current = null;
          hqFinishedRef.current.add(runId);
          if (hqFinishedRef.current.size > 100) hqFinishedRef.current.delete(hqFinishedRef.current.values().next().value!);
          clearStoredHQRunId();
          void loadStatus(); // settle the run table (runStatus just flipped)
          scheduleLogRefresh(); // the run wrote its files — ONE log refresh
        })
        .catch((e: unknown) => {
          if (hqAttachRef.current?.controller !== controller) return;
          hqAttachRef.current = null;
          setHqLive(false);
          if (!controller.signal.aborted) {
            const attempts = (hqRetryRef.current.get(runId)?.attempts ?? 0) + 1;
            hqRetryRef.current.set(runId, { attempts, after: Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)) });
          }
          // A gone run (404) invalidates the stash; a transport failure
          // keeps it — the discovery poll below re-attaches.
          if (e instanceof HQStreamError && e.code === "not_found") {
            clearStoredHQRunId();
            hqAppliedRef.current = null;
          }
        });
    },
    [detachHQ, loadStatus, scheduleLogRefresh],
  );

  // ── Turn/summary run watchers (v0.11 streams) ─────────────────────────────
  // Every live run the status table names gets its OWN SSE attachment; the
  // moment the run's durable stream reaches a terminal frame (or closes) the
  // watcher schedules ONE debounced log refresh — that is the whole GitHub
  // read rhythm: open / terminal / manual, never the clock.
  const runWatchers = useMemo(() => createRunWatchers({
    watch: watchChatRunEnd,
    onTerminal: () => {
      void loadStatus();
      scheduleLogRefresh();
    },
  }), [loadStatus, scheduleLogRefresh]);
  useEffect(() => {
    const reflectionRunId = hq?.reflection.state === "live" ? hq.reflection.runId : null;
    const runIds = hq?.runs.state === "live"
      ? hq.runs.live.filter((row) => row.runId !== reflectionRunId).map((row) => row.runId)
      : [];
    runWatchers.sync(runIds, open && visible);
  }, [open, visible, hq, runWatchers]);

  // One visibility-owned clock: the open panel reads status every 3s;
  // closed discovery reads every 15s until an HQ stream owns the feed.
  useEffect(() => {
    if (!visible || document.visibilityState === "hidden") {
      detachHQ();
      return;
    }
    let stopped = false;
    let discovering = false;
    const controller = new AbortController();
    const discover = async () => {
      if (stopped || discovering || (!open && hqAttachRef.current)) return;
      discovering = true;
      const status = await loadStatus(controller.signal).finally(() => { discovering = false; });
      if (stopped || controller.signal.aborted || document.visibilityState === "hidden" || !status) return;
      if (status.reflection.state === "live" &&
        (status.reflection.status === "running" || status.reflection.status === "pending")) {
        attachHQ(status.reflection.runId);
      }
    };
    void discover();
    const timer = setInterval(() => void discover(), open ? 3000 : HQ_DISCOVERY_POLL_MS);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [open, visible, loadStatus, attachHQ, detachHQ]);

  useEffect(() => () => {
    detachHQ();
    runWatchers.dispose();
    scheduleLogRefresh.cancel();
    logAbortRef.current?.abort();
  }, [detachHQ, runWatchers, scheduleLogRefresh]);

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
    const hidden = () => document.visibilityState === "hidden";
    if (hidden()) return;
    const seq = ++memoryMapSeqRef.current;
    const [episodic, skeleton] = await Promise.all([
      getEpisodicState().catch(() => null),
      getTimelineSkeleton().catch(() => null),
    ]);
    // A close/reopen superseded this read — its snapshot would be stale.
    if (hidden() || seq !== memoryMapSeqRef.current) return;
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
    if (open && visible) void loadMemoryMap();
  }, [open, visible, loadMemoryMap]);

  const speaking =
    target !== null && (status === "connecting" || status === "streaming");
  // v0.39 §1 — roundActive retired with hq.json: round liveness is a
  // STREAM-side signal, so the active state follows the live attachment itself.
  const hqBreathing = hqLive;
  const active = speaking || working || hqBreathing;
  const hasLiveTarget = target !== null;
  /** A cut narration — the tab's corner mark is an engraved exclamation
      (still ink, never red). */
  const narrationError = hasLiveTarget && status === "error";
  /** An unread completion: a narration or an evolution event landed while
      the panel was shut. Opening the panel clears its unread marker. */
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
      className={`${styles.root} pointer-events-none fixed right-2 z-50 flex flex-col items-end md:right-4 companion-pod-root`}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              data-companion-pod
              data-active={active}
              aria-label={t("wfTabWorkflows")}
              title={t("wfTabWorkflows")}
              className={`${styles.trigger} pointer-events-auto gap-1.5 font-mono text-xs data-[active=true]:border-brand/50 data-[active=true]:bg-brand/10 data-[active=true]:text-brand`}
            />
          }
        >
          {t("nameTab")}
          {active && (
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
          )}
          {narrationError ? (
            <CircleAlert aria-hidden className="size-3.5" />
          ) : unread ? (
            <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          ) : null}
        </PopoverTrigger>

        <PopoverContent
          data-companion-pod-panel
          side="top"
          align="end"
          sideOffset={8}
          aria-label={t("wfTabWorkflows")}
          className={`${styles.panel} pointer-events-auto gap-0 overflow-hidden p-0`}
        >
            {/* The header stays fixed while the body uses the remaining height. */}
            <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
              <span className="text-sm font-medium">{t("wfTabWorkflows")}</span>
              {narrationError ? (
                <CircleAlert aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
              ) : (
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-sm ${
                    active ? "bg-brand" : "bg-muted-foreground/50"
                  }`}
                />
              )}
              {headerTimeLabel && (
                <span className="font-mono text-xs tabular-nums tracking-wide text-muted-foreground/70">
                  {headerTimeLabel}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={closePanel}
                aria-label={t("close")}
                title={t("close")}
                className="ml-auto"
              >
                <X className="size-3.5" />
              </Button>
            </div>

            {/* Prose — serif. Plain text, line breaks preserved; no markdown. */}
            <ScrollArea className={styles.scroll}>
              {target && status === "error" ? (
                <div className="px-4 pb-4 pt-2">
                  {/* A cut narration keeps the part that WAS told above the
                      error note — the stream's failure marker is stripped by
                      the helper, so `text` here is real prose only. */}
                  {text && (
                    <p className="whitespace-pre-wrap font-serif text-sm font-light leading-relaxed text-foreground/90">
                      {text}
                    </p>
                  )}
                  <p
                    className={`font-serif text-sm font-light leading-relaxed text-muted-foreground ${
                      text ? "mt-2" : ""
                    }`}
                  >
                    {error ? errorMessage(error, t) : t("errorGeneric")}
                  </p>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => onRetry(target.sliceId, target.timeLabel)}
                    className="mt-2 h-auto px-0 font-sans text-xs font-normal text-muted-foreground"
                  >
                    {t("retry")}
                  </Button>
                </div>
              ) : target && text ? (
                <div aria-live="polite" className="px-4 pb-4 pt-2">
                  <p className="whitespace-pre-wrap font-serif text-sm font-light leading-relaxed text-foreground/90">
                    {text}
                    {speaking && (
                      <span aria-hidden className="text-brand">
                        ▍
                      </span>
                    )}
                  </p>
                </div>
              ) : target ? (
                /* No chunk yet — the thinking line reserves the body so the
                    card does not jump when the first words land. */
                <div className="px-4 pb-4 pt-2">
                  <p className="font-serif text-sm font-light italic leading-relaxed text-muted-foreground/80">
                    {t("thinking")}
                  </p>
                </div>
              ) : latest ? (
                /* The replay — what Previously last said, kept after the
                    stream was dismissed. Read-only: no caret, no retry. */
                <div aria-live="polite" className="px-4 pb-4 pt-2">
                  <p className="whitespace-pre-wrap font-serif text-sm font-light leading-relaxed text-foreground/90">
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
                    <p className="font-serif text-sm font-light italic leading-relaxed text-muted-foreground/80">
                      {t("evolutionWorking")}
                    </p>
                  ) : evolution?.latest?.failed ? (
                    <p className="font-serif text-sm font-light leading-relaxed text-muted-foreground">
                      {t("evolutionFailed")}
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap font-serif text-sm font-light leading-relaxed text-foreground/90">
                      {evolution?.latest?.summary?.trim()
                        ? evolution.latest.summary
                        : t("evolvedFallback")}
                    </p>
                  )}
                </div>
              ) : null}

              {/* v0.43 — the workflow panel IS the panel's face: two tabs
                  (状态 / 工作流) over the four status zones; nothing folds,
                  the data attributes stay for the probes. */}
              <div className="border-t border-border">
                <div
                  data-companion-pod-debug
                  className="space-y-3 px-4 pb-3 font-sans text-xs leading-relaxed text-foreground/80"
                >
                  <div className="flex items-center justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        // The manual refresh reads status AND log; the log is
                        // event-triggered otherwise.
                        void loadStatus();
                        void loadLog();
                      }}
                      aria-label={t("debugRefresh")}
                      title={t("debugRefresh")}
                    >
                      <RefreshCw className="size-3" />
                    </Button>
                  </div>
                  <WorklogTabs
                    data={hq}
                    failed={hqFailed}
                    log={hqLog}
                    logFailed={hqLogFailed}
                    t={t}
                    locale={locale}
                    activity={hqActivity}
                    open={open}
                    requestCancel={(targets) => {
                      // §4.3/§2.3 — the panel's ONLY write, through the
                      // existing cancel endpoint; then re-read. A cancel ends
                      // the runs — the watchers' terminals ALSO schedule a
                      // log refresh (the debounce collapses the pair).
                      for (const runId of targets) {
                        void cancelPanelRun(runId);
                      }
                      void loadStatus();
                      scheduleLogRefresh();
                    }}
                  />
                </div>
                <div
                  data-companion-pod-debug
                  className="space-y-3 px-4 pb-3 font-sans text-xs leading-relaxed text-foreground/80"
                >
                  <DebugSection
                    id="memory"
                    title={t("debugMemoryTitle")}
                    action={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void loadMemoryMap()}
                        aria-label={t("debugRefresh")}
                        title={t("debugRefresh")}
                      >
                        <RefreshCw className="size-3" />
                      </Button>
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
            </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The pod is PORTALED to <body> (2026-10-20). It used to live inside the
 * shell subtree, and that subtree carries its own stacking context: a
 * z-index on the pod only ordered it among its own siblings, so the
 * fullscreen conversation (z-50, later in the shell) covered it however high
 * that number went. Mounted at the end of <body> it competes on the page's
 * own scale, and DOM order gives it the tie against the conversation panel —
 * while a dialog, portaled later still, keeps painting over it.
 */
export function CompanionPod(
  props: React.ComponentProps<typeof CompanionPodBody>,
) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(<CompanionPodBody {...props} />, document.body);
}
