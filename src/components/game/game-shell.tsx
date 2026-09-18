"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { getTimelineCatalog, getStrandPaths } from "@/lib/episodic/actions";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import { buildStrandGraph } from "@/lib/game/strand-graph";
import { sliceClockTime } from "@/lib/game/slice-clock";
import {
  buildRoomDoorMap,
  type RoomDoorMap,
} from "@/lib/game/strand-doors";
import type { CorridorDoor } from "./corridor";

/**
 * v1 door cap. Corridor streaming can present far more, but the first version
 * bounds the walk to the newest MAX_DOORS slices; older history can stream in
 * once the corridor proves out.
 */
const MAX_DOORS = 200;

/**
 * Empty-state fallback (fresh user / unwoven demo env): a static corridor so
 * the hotel still opens on an empty timeline. The pinned archetypes double as
 * a showcase of the four space types.
 */
const FALLBACK_DOORS: readonly CorridorDoor[] = [
  { sliceId: "2026-09-12-0941", label: "Sep 12 · 09:41", archetype: "meadow" },
  { sliceId: "2026-09-13-1530", label: "Sep 13 · 15:30", archetype: "plains" },
  { sliceId: "2026-09-14-2207", label: "Sep 14 · 22:07", archetype: "pool" },
  { sliceId: "2026-09-15-1401", label: "Sep 15 · 14:01", archetype: "forest" },
];

/** The fetch-failure warning logs once per session — the fallback is already up. */
let warnedCatalogFailure = false;
/** Same once-per-session treatment for the strand read; empty doors are the fallback. */
let warnedStrandFailure = false;

/**
 * No-strand-data default: every room renders exactly as before strand doors
 * (v0.11-hotel-rooms 附录 B) existed. Referentially stable so the canvas
 * never re-renders on a fresh empty map.
 */
const NO_ROOM_DOORS: RoomDoorMap = new Map();

/** No-strand-data default for the strand hotels (HD4): referentially
 *  stable like NO_ROOM_DOORS. */
const NO_TIMELINES: ReadonlyMap<string, readonly CorridorDoor[]> = new Map();

const GameCanvas = dynamic(() => import("./game-canvas"), {
  ssr: false,
  loading: () => <GameLoading />,
});

function GameLoading() {
  const t = useTranslations("game");
  return (
    <div className="flex h-full w-full items-center justify-center">
      <p className="text-sm text-muted-foreground">{t("loading")}</p>
    </div>
  );
}

/**
 * "Sep 12 · 09:41" — the calendar half comes from the slice's own `date`,
 * parsed BY COMPONENTS (`new Date("YYYY-MM-DD")` alone reads as UTC midnight
 * and can render as the previous day behind negative timezones); the HH:mm
 * half comes from the UTC `start` ISO, shown in the user's local time.
 */
function formatDoorLabel(date: string, isoStart: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day =
    y && m && d
      ? dateTimeFormat(locale, { month: "short", day: "numeric" }).format(
          new Date(y, m - 1, d),
        )
      : "";
  const start = new Date(isoStart);
  const time = isNaN(start.getTime())
    ? ""
    : dateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
        start,
      );
  return [day, time].filter(Boolean).join(" · ");
}

/**
 * The door NUMBER (B.14 用户定稿 rule 1): the slice's own 4-digit clock
 * (`…-0746` → `0746`), so the same slice hangs the same number on its
 * corridor plate and on every strand door that leads to it. The rule lives
 * in lib/game/slice-clock.ts — the single source both this file and the
 * corridor import (previously a mirrored copy kept in sync by comment).
 * Ids that do not match (fixtures, tests) get no number — the corridor's
 * own "no signage" case. Never derive this from `formatDoorLabel`'s time
 * half: that one is locale-local time rendered from the UTC `start`, which
 * can differ from the id's clock.
 */

/**
 * GameShell — the game VIEW under the single route (§14 merge): it owns the
 * hotel's data lane (catalog → corridor doors, strand graph → room doors and
 * strand hotels) and the minimal overlay chrome. Two things it NO LONGER
 * owns:
 *
 *   - the canvas — `game-canvas.tsx` renders its scene subtree into the
 *     app's ONE shared canvas (world-canvas.tsx) through the world slot.
 *   - the conversation — the shell's persistent three-tier panel
 *     (§14.1) floats over this view exactly as it does over the field;
 *     the app shell owns its state and the world's fullscreen freeze.
 *
 * `onExit` leaves the view (the app shell switches back to the field world);
 * `focusSlice` is the shared `?slice=` address — the canvas enters the
 * slice's own hotel window when it resolves (see game-canvas.tsx).
 */
export function GameShell({
  onExit,
  focusSlice = null,
}: {
  onExit: () => void;
  focusSlice?: string | null;
}) {
  const t = useTranslations("game");
  const locale = useLocale();
  // null = the catalog is still in flight; the corridor mounts only once the
  // doors resolve (to the timeline, or to the fallback on empty/error).
  const [doors, setDoors] = useState<readonly CorridorDoor[] | null>(null);
  // The strand-door map (slice id → the room's strand doors, B.11). Empty
  // until the strand read resolves, and stays empty if it fails — the game
  // must work exactly as it does today without strands.
  const [roomDoors, setRoomDoors] = useState<RoomDoorMap>(NO_ROOM_DOORS);
  // The strand hotels (HD4): strand name → its timeline as a corridor door
  // list (newest first, same shape as `doors`). Empty until the strand read
  // resolves, and stays empty if it fails.
  const [timelines, setTimelines] =
    useState<ReadonlyMap<string, readonly CorridorDoor[]>>(NO_TIMELINES);

  // The conversation layer is NOT here (§14 merge): the app shell's panel
  // floats over this view too, and Escape's panel-then-view precedence lives
  // with the shell, which owns the panel's mode.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const catalog = await getTimelineCatalog();
        if (cancelled) return;
        if (catalog.length === 0) {
          setDoors(FALLBACK_DOORS);
          return;
        }
        // The catalog arrives oldest → newest; corridor door index 0 is the
        // door NEAREST the lobby — the NEWEST slice — so present it reversed,
        // capped to the newest MAX_DOORS. `start` goes along: the corridor's
        // door spacing is a function of the time gaps between slices, and it
        // computes those from the timestamps without parsing ids.
        const corridorDoors = catalog
          .slice(-MAX_DOORS)
          .reverse()
          .map((entry) => ({
            sliceId: entry.id,
            label: formatDoorLabel(entry.date, entry.start, locale),
            start: entry.start,
          }));
        setDoors(corridorDoors);

        // Strand doors (附录 B.11, resolution layer): one door per strand
        // through each slice, leading to the next slice on that strand. Its
        // own try/catch — a strand-read failure must degrade to "no strand
        // doors", never take the corridor down with it.
        try {
          const graph = buildStrandGraph(await getStrandPaths());
          if (cancelled) return;
          const entryById = new Map(catalog.map((entry) => [entry.id, entry]));
          // The strand hotels (HD4): each strand's path (chronological)
          // becomes a corridor door list, newest first like the core
          // corridor. Labels come from the catalog entry when one exists;
          // a strand-only slice (not on the core timeline) gets its bare id.
          const strandTimelines = new Map<string, readonly CorridorDoor[]>();
          for (const [name, path] of graph.paths) {
            strandTimelines.set(
              name,
              [...path].reverse().map((id) => {
                const entry = entryById.get(id);
                return {
                  sliceId: id,
                  label: entry
                    ? formatDoorLabel(entry.date, entry.start, locale)
                    : id,
                  start: entry?.start,
                };
              }),
            );
          }
          setTimelines(strandTimelines);
          setRoomDoors(
            buildRoomDoorMap({
              graph,
              sliceIds: corridorDoors.map((door) => door.sliceId),
              // Plaque: the strand name + the destination's date, in the
              // corridor doors' own label format ("工作 → Sep 15 · 07:46"),
              // plus the destination slice's door NUMBER as a `#HHMM`
              // suffix (B.14 rule 1) — the room renderer splits the suffix
              // off (before any truncation) and hangs it on its own small
              // plate, the corridor plate's twin. Unlit doors are labeled
              // by the resolver with the bare name and get no number: an
              // unlit door has no destination (B.4).
              label: ({ strand, destinationSliceId }) => {
                const entry = entryById.get(destinationSliceId);
                const date = entry
                  ? formatDoorLabel(entry.date, entry.start, locale)
                  : destinationSliceId;
                const clock = sliceClockTime(destinationSliceId);
                return clock
                  ? `${strand} → ${date}#${clock}`
                  : `${strand} → ${date}`;
              },
            }),
          );
        } catch (err) {
          if (cancelled) return;
          if (!warnedStrandFailure) {
            warnedStrandFailure = true;
            console.warn(
              "[game] getStrandPaths failed; rooms render without strand doors",
              err,
            );
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (!warnedCatalogFailure) {
          warnedCatalogFailure = true;
          console.warn(
            "[game] getTimelineCatalog failed; showing fallback doors",
            err,
          );
        }
        setDoors(FALLBACK_DOORS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  return (
    <div className="relative h-full w-full">
      {/* Top-left overlay: title + exit. The container is pointer-transparent
          so it never blocks walking; only the button re-enables pointer
          events. Exit is a WORLD SWITCH now (§14), not a navigation. */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 sm:left-6 sm:top-6">
        <p className="text-sm font-semibold tracking-tight text-neutral-100">
          {t("title")}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="pointer-events-auto text-xs text-neutral-400 transition-colors hover:text-neutral-200"
        >
          {t("exit")}
        </button>
      </div>
      {doors ? (
        <GameCanvas
          doors={doors}
          roomDoors={roomDoors}
          timelines={timelines}
          focusSlice={focusSlice}
        />
      ) : (
        <GameLoading />
      )}
    </div>
  );
}
