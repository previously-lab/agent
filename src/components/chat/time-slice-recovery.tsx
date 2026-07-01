"use client";

import { useCallback, useMemo } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimeSliceSnapshot {
  focus: string;
  summary: string;
  open_loops: string[];
  decisions: string[];
  lastActivity: string; // ISO 8601
  /** Number of turns in the slice. Shown alongside the relative time. */
  turnCount?: number;
}

export interface TimeSliceRecoveryProps {
  slice: TimeSliceSnapshot | null;
  /** Called when the user clicks "Continue". Expected to focus the chat input. */
  onContinue?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000; // seconds

  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m} minute${m > 1 ? "s" : ""} ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h} hour${h > 1 ? "s" : ""} ago`;
  }
  if (diff < WEEK) {
    const d = Math.floor(diff / DAY);
    return `${d} day${d > 1 ? "s" : ""} ago`;
  }
  const d = Math.floor(diff / DAY);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

/** Format "2 hours ago · 6 turns" from slice metadata. */
function formatActivityLine(slice: TimeSliceSnapshot): string {
  const time = relativeTime(slice.lastActivity);
  if (slice.turnCount && slice.turnCount > 0) {
    return `${time} · ${slice.turnCount} turn${slice.turnCount > 1 ? "s" : ""}`;
  }
  return time;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Rendered when there is no history at all — the very first time someone opens the app. */
function FirstTimeWelcome({ className }: { className?: string }) {
  return (
    <Card
      size="sm"
      className={cn(
        "border-dashed border-muted-foreground/20 bg-muted/30 text-center",
        className,
      )}
    >
      <CardContent className="flex flex-col items-center gap-3 py-6">
        <span className="text-2xl" aria-hidden>
          🫧
        </span>

        <div>
          <p className="text-sm font-medium text-foreground">Afterbreeze</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            I&rsquo;m your Agent. Our relationship is continuous — every
            interaction becomes a memory.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Rendered when a previous time-slice exists — prompts the user to continue. */
function RecoveryCard({
  slice,
  onContinue,
  className,
}: {
  slice: TimeSliceSnapshot;
  onContinue?: () => void;
  className?: string;
}) {
  const activityLine = useMemo(() => formatActivityLine(slice), [slice]);

  const handleContinue = useCallback(() => {
    onContinue?.();
  }, [onContinue]);

  return (
    <Card
      size="sm"
      className={cn(
        "border-muted-foreground/15 bg-muted/20",
        className,
      )}
    >
      <CardContent className="flex flex-col gap-3 py-4">
        {/* Header row: pin icon + focus + activity time */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              <span className="mr-1.5 select-none" aria-hidden>
                📍
              </span>
              Continue:{" "}
              <span className="font-semibold">{slice.focus}</span>
            </p>
            {slice.summary && (
              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {slice.summary}
              </p>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleContinue}
            className="shrink-0"
          >
            Continue
          </Button>
        </div>

        {/* Footer: relative time + turn count */}
        <p className="text-[0.7rem] text-muted-foreground/70">
          {activityLine}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * TimeSliceRecovery
 *
 * Recovery card shown when the user returns after a page refresh. It lives
 * **above** the chat input area — not inside the message list — so it acts as
 * a subtle reminder, not a modal takeover.
 *
 * - `slice === null` → first-time welcome state
 * - `slice` exists   → recovery card with focus, summary, time-since, and a
 *   "Continue" button that focuses the input
 */
export function TimeSliceRecovery({
  slice,
  onContinue,
  className,
}: TimeSliceRecoveryProps) {
  if (!slice) {
    return <FirstTimeWelcome className={className} />;
  }

  return (
    <RecoveryCard slice={slice} onContinue={onContinue} className={className} />
  );
}
