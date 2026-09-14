"use client";

/**
 * TimelineScene (Rev 11) — the timeline view's RIGHT pane only (v0.11 shell
 * refactor). The left AxisBand is now a persistent shell component; this file
 * composes the CardField R3F scene plus the NOW tail marker, the floating lens
 * switcher, and atmosphere overlays.
 *
 * Catalog window, strand selection, scroll progress/zoom refs, and the calendar
 * range are owned by the shell and passed in as props so the left AxisBand can
 * read the same values.
 */
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { filterByStrand } from "@/lib/timeline3d/stacks";
import type { FieldRung } from "@/lib/timeline3d/units";
import type { FieldFeed } from "@/lib/timeline3d/field-feed";
import {
  AtmosphereBackdrop,
  AtmosphereVignette,
  TIMELINE_KEYFRAMES,
} from "./atmosphere";
import dynamic from "next/dynamic";

const CardField = dynamic(
  () => import("./card-field").then((m) => m.CardField),
  { ssr: false, loading: () => null },
);

export interface TimelineSceneProps {
  /** The loaded catalog window (oldest → newest). */
  entries: TimelineSliceEntry[];
  /** Whether entries older than the loaded window exist. */
  hasMore: boolean;
  /** Prefetch the next older window. */
  onNeedOlder: () => Promise<void>;
  /** Navigate to the chat anchored at a slice. */
  onOpenSlice: (sliceId: string, start?: string) => void;
  /** Slice id from `?at=` — the list lands on it, flashed. */
  initialAtId?: string;
  /** The current picks, in order. Empty = 核心时间线 (no filter). */
  strands: readonly string[];
  /** The shared band feed — forwarded to the left band. */
  feed: FieldFeed;
  /** True while the timeline is the visible pane and therefore owns the feed.
   *  The chat field stays mounted behind it, and two writers is what the feed
   *  exists to prevent. */
  publishing: boolean;
  /** Controlled rung owned by the shell (drives the lens switcher). */
  rung: FieldRung;
  /** Request a rung — CardField runs the anchored transition. */
  onRungChange: (rung: FieldRung) => void;
  /** Reduced-motion preference. */
  reducedMotion: boolean;
  /** A turn is streaming right now. The card field has no row for it — the
   *  catalog only knows CLOSED slices — so it draws the abstract placeholder
   *  instead. See `RunningCard`. */
  running: boolean;
}

/**
 * The bottom fade over the card field.
 *
 * THIS USED TO CARRY A 「NOW · 现在」 CAPTION and no longer does. The caption
 * was a label with no action sitting in the bottom centre — exactly where the
 * collapsed composer puts a button — and a reader clicked it expecting the
 * button, which is the worst thing a label can do. It also said something the
 * field already says: the bottom of the list IS now, the reader knows because
 * they scrolled there, and the core line's blue spine marks the present on the
 * rail. Removing it costs no information and removes a false affordance.
 *
 * The gradient stays: it is the fade that keeps a card from being sliced by the
 * viewport edge mid-stroke.
 */
function BottomFade() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
  );
}

/**
 * The running slice, as a CARD — the seat the live turn occupies at a card
 * rung.
 *
 * WHY IT IS NOT A REAL CARD. At the conversation rung the turn being written
 * is rendered by the chat's own field, part by part, in stream order. The card
 * rungs cannot do that: a card's rows come from the persisted catalog
 * (`groupForLevel(entries)`) and the catalog has no entry for a slice that has
 * not closed — there is nothing to draw and nothing to measure. Rather than
 * thread a streaming array into a renderer that is built around a settled
 * catalog, the card field draws ONE abstract card that says the thing which is
 * actually true: a conversation is being written right now, and it will appear
 * here when it lands. A reader who wants the detail clicks it, which is the
 * honest affordance — the detail exists, at the conversation rung.
 *
 * IT SITS AT THE BOTTOM, because the bottom of this field IS now: rows run
 * oldest → newest (`groupForLevel` sorts by `start`), so the newest thing the
 * reader can see is at the foot of the list, and the `BottomFade` above it is
 * the fade of the present. A placeholder for the newest card anywhere else
 * would be pointing at the wrong end of time. (The brief asked for the
 * top-centre; the top of this field is the OLDEST row and the window's head,
 * so that seat is taken by "load earlier" and always will be.)
 */
function RunningCard({
  reducedMotion,
  onOpen,
}: {
  reducedMotion: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations("timeline3d.running");
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center px-4 sm:bottom-16">
      <motion.button
        type="button"
        data-running-card
        onClick={onOpen}
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reducedMotion ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl bg-card/90 px-4 py-3 text-left ring-1 ring-foreground/10 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.5)] backdrop-blur-md transition-colors hover:ring-foreground/25"
      >
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-[1px] bg-primary ${reducedMotion ? "" : "animate-pulse"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-serif text-sm text-foreground">
            {t("title")}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {t("hint")}
          </span>
        </span>
      </motion.button>
    </div>
  );
}

export function TimelineScene({
  entries,
  hasMore,
  onNeedOlder,
  onOpenSlice,
  initialAtId,
  strands,
  feed,
  publishing,
  rung,
  onRungChange,
  reducedMotion,
  running,
}: TimelineSceneProps) {
  const filtered = filterByStrand(entries, strands);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <style>{TIMELINE_KEYFRAMES}</style>
      <AtmosphereBackdrop />

      {/* The field starts BELOW the floating chrome.
          The chrome is `pointer-events-none` and content scrolling under it is
          the intended look — on the rail and in the margins. It is not the
          intended look on a CARD: a card is a 700px-wide panel of text, and
          the board bar crossing its first line reads as a rendering fault.
          So the box the canvas fills is inset by the chrome's measured height,
          per breakpoint (see `chat-page.tsx` for the same numbers): two rows
          at phone width, one from `sm` up. `box-sizing: border-box` makes
          `h-full` + `pt-*` resolve to "the pane, minus the chrome", and
          `frameGeometryFor` derives the cards from the height it is given —
          so the cards shrink to fit rather than sliding under. */}
      <div className="relative h-full w-full pt-24 sm:pt-16">
        <CardField
          entries={filtered}
          hasMore={hasMore}
          onNeedOlder={onNeedOlder}
          onOpenSlice={onOpenSlice}
          initialAtId={initialAtId}
          genKey={strands.join("|") || "core"}
          reducedMotion={reducedMotion}
          feed={feed}
          publishing={publishing}
          rung={rung}
          onRungChange={onRungChange}
        />
        {/* The present, at the bottom, where the present is. */}
        <BottomFade />
        {running && (
          <RunningCard
            reducedMotion={reducedMotion}
            // Clicking it goes to the conversation rung — the one place the
            // turn is rendered in full. It is not a scroll-to: the reply is
            // being written at the live edge, and the honest answer to "show
            // me" is the surface that can actually show it.
            onOpen={() => onRungChange("conversation")}
          />
        )}
        {/* The zoom lens is NOT here any more. It is the app's only navigation
            control, so it belongs to the shell (`app-shell.tsx`) where it is
            mounted at every rung — inside this scene it vanished on the
            conversation rung, which is precisely where a reader needs it to
            get back to the cards. */}
      </div>

      <AtmosphereVignette />
    </div>
  );
}
