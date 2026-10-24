"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { getTimelineSkeleton, getStrandPaths } from "@/lib/episodic/actions";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import { buildStrandGraph } from "@/lib/game/strand-graph";
import { sliceClockTime } from "@/lib/game/slice-clock";
import {
  buildRoomDoorMap,
  type RoomDoorMap,
} from "@/lib/game/strand-doors";
import {
  captureHotelDataRequest,
  hotelDataEpoch,
  readHotelDataAtEpoch,
  writeHotelDataAtEpoch,
  HOTEL_WINDOW_DOORS,
} from "@/lib/game/hotel-data";
import type { RoomSnapshot } from "@/lib/game/room-snapshot";
import { debugUnitsFor, isDebugPage } from "@/lib/game/debug-catalog";
import { CAMERA_PARAM, cameraModeFor } from "@/lib/game/chase-camera";
import {
  DEBUG_PAGE_PARAM,
  DEBUG_PARAM,
  DEBUG_QUERY_VALUE,
  DEBUG_SKIN_PARAM,
} from "@/lib/game/debug-slice";
import type { CorridorDoor } from "./corridor";
import { NavOverflowMenu } from "@/components/layout/nav-overflow-menu";
import { Link } from "@/i18n/navigation";

/**
 * v1 door cap. Corridor streaming can present far more, but the first version
 * bounds the walk to the newest MAX_DOORS slices; older history can stream in
 * once the corridor proves out.
 */
const MAX_DOORS = HOTEL_WINDOW_DOORS;

/** A fresh archive opens in the real lobby. Demonstration rooms belong only
 * to the explicit debug gallery; they never impersonate conversation records. */
const EMPTY_DOORS: readonly CorridorDoor[] = [];

/** The fetch-failure warning logs once per session; the lobby remains usable. */
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
 * hotel's data lane (skeleton → corridor doors, strand graph → room doors and
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
  onOpenDoc,
  suspended = false,
  persona = "user",
  sourceScope,
  dataGeneration = 0,
  onRoomSnapshotChange,
}: {
  onExit: () => void;
  focusSlice?: string | null;
  /** A room paper's interact (v0.25a §五 B②): open the sheet's document in
   *  the original manuscript — the app shell switches worlds (desk) there. */
  onOpenDoc?: (ref: string) => void;
  /** THE DOCUMENT PAUSE (v0.28 step 1): the document tier sits over the
   *  frozen world — the view's chrome (title/exit, the gallery switcher)
   *  stands down with the simulation, exactly like the in-world HUD. */
  suspended?: boolean;
  persona?: string;
  /** Server-resolved deployment/source labels; never credentials or paths. */
  sourceScope: string;
  /** A refresh starts a new cache epoch while a mounted room stays frozen. */
  dataGeneration?: number;
  onRoomSnapshotChange?: (snapshot: RoomSnapshot | null) => void;
}) {
  const t = useTranslations("game");
  const locale = useLocale();
  const [activeScenario, setActiveScenario] = useState<string | null>(null);

  // THE GALLERY (the standard-room review pass): `?view=game&debug=rooms
  // &page=modules|templates|archetypes` swaps the corridor's doors for one
  // door per STANDARD unit, so each can be walked — and decorated — on its
  // own. `&skin=<id>` (v0.12 P3) prefixes every door with that biome skin
  // (debug-catalog.ts; unknown ids are ignored). The force rides in the
  // synthetic slice id (debug-slice.ts), so nothing else in the room
  // pipeline needs to know this mode exists.
  const searchParams = useSearchParams();
  const galleryPage = useMemo(() => {
    const page = searchParams.get(DEBUG_PAGE_PARAM);
    return isDebugPage(page) ? page : "modules";
  }, [searchParams]);
  const galleryDoors = useMemo<readonly CorridorDoor[] | null>(
    () =>
      searchParams.get(DEBUG_PARAM) === DEBUG_QUERY_VALUE
        ? debugUnitsFor(galleryPage, searchParams.get(DEBUG_SKIN_PARAM)).map(
            (unit) => ({
              sliceId: unit.sliceId,
              label: unit.label,
            }),
          )
        : null,
    [searchParams, galleryPage],
  );

  /**
   * Swap the corridor for the gallery (or drop it) by rewriting the query —
   * a DEV affordance, so it rides on the same URL the mode is read from and
   * leaves nothing behind in the hotel's data lane.
   */
  const router = useRouter();
  const pathname = usePathname();
  const setGallery = (page: "modules" | "templates" | "archetypes" | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (page === null) {
      params.delete(DEBUG_PARAM);
      params.delete(DEBUG_PAGE_PARAM);
    } else {
      params.set(DEBUG_PARAM, DEBUG_QUERY_VALUE);
      params.set(DEBUG_PAGE_PARAM, page);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // THE CACHED LANE SURVIVES VIEW SWITCHES: a remount after field → game →
  // field reuses the previously derived (doors, roomDoors, timelines)
  // instead of two server reads plus a second-pass room-door rebuild. The
  // lazy initializers read it synchronously so a warm switch mounts the
  // canvas in the same commit the view flips — one build, full data, the
  // fast path a cold entry already takes. Staleness is bounded by the
  // invalidation contract in hotel-data.ts: a turn settle bumps the epoch,
  // a locale change misses the key, a reload clears the module.
  const cacheScope = JSON.stringify([sourceScope, persona]);
  const cachedLane = readHotelDataAtEpoch(locale, captureHotelDataRequest(cacheScope));
  // null = the skeleton is still in flight; the corridor mounts only once the
  // doors resolve (to the timeline, or to the fallback on empty/error). The
  // gallery replaces the lot with its own door list.
  const [doors, setDoors] = useState<readonly CorridorDoor[] | null>(
    () => galleryDoors ?? cachedLane?.doors ?? null,
  );
  // The strand-door map (slice id → the room's strand doors, B.11). Empty
  // until the strand read resolves, and stays empty if it fails — the game
  // must work exactly as it does today without strands.
  const [roomDoors, setRoomDoors] = useState<RoomDoorMap>(
    () => cachedLane?.roomDoors ?? NO_ROOM_DOORS,
  );
  // The strand hotels (HD4): strand name → its timeline as a corridor door
  // list (newest first, same shape as `doors`). Empty until the strand read
  // resolves, and stays empty if it fails.
  const [timelines, setTimelines] =
    useState<ReadonlyMap<string, readonly CorridorDoor[]>>(
      () => cachedLane?.timelines ?? NO_TIMELINES,
    );

  // The conversation layer is NOT here (§14 merge): the app shell's panel
  // floats over this view too, and Escape's panel-then-view precedence lives
  // with the shell, which owns the panel's mode.

  useEffect(() => {
    // The gallery owns the door list outright: no catalog read, no strand
    // graph — the corridor shows the standard units and nothing else.
    if (galleryDoors) {
      setDoors(galleryDoors);
      setRoomDoors(NO_ROOM_DOORS);
      setTimelines(NO_TIMELINES);
      return;
    }
    // Cache hit (state was initialized from it): nothing to fetch. Re-read
    // rather than trust the mount-time value — an epoch bump between the
    // render and this effect (a turn settling in that window) must send us
    // down the fetch path like any stale entry. The cached doors go back in
    // too: leaving the gallery left ITS list in the state.
    const request = captureHotelDataRequest(cacheScope);
    const cached = readHotelDataAtEpoch(locale, request);
    if (cached) {
      setDoors(cached.doors);
      setRoomDoors(cached.roomDoors);
      setTimelines(cached.timelines);
      return;
    }
    let cancelled = false;
    const isCurrent = () => !cancelled && request.epoch === hotelDataEpoch();
    (async () => {
      try {
        const skeleton = await getTimelineSkeleton(persona);
        if (!isCurrent()) return;
        if (skeleton.length === 0) {
          setDoors(EMPTY_DOORS);
          setRoomDoors(NO_ROOM_DOORS);
          setTimelines(NO_TIMELINES);
          writeHotelDataAtEpoch(locale, {
            doors: EMPTY_DOORS,
            roomDoors: NO_ROOM_DOORS,
            timelines: NO_TIMELINES,
          }, request);
          return;
        }
        // The skeleton arrives oldest → newest; corridor door index 0 is the
        // door NEAREST the lobby — the NEWEST slice — so present it reversed,
        // capped to the newest MAX_DOORS. `start` goes along: the corridor's
        // door spacing is a function of the time gaps between slices, and it
        // computes those from the timestamps without parsing ids.
        const corridorDoors = skeleton
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
        //
        // THE SOURCE IS RETIRED: strands.json has not been generated since
        // A1 (§A.2.4), so this graph can only grow staler until it is empty.
        // An empty graph draws NO doors — no empty doorframes, no wrong
        // doors — and says so once. Anchoring the rooms to CASES instead is
        // a separate piece of work, not a patch on this resolver.
        try {
          const graph = buildStrandGraph(await getStrandPaths());
          if (!isCurrent()) return;
          if (graph.paths.size === 0) {
            if (!warnedStrandFailure) {
              warnedStrandFailure = true;
              console.warn(
                "[game] strand source retired/empty; rooms render without strand doors",
              );
            }
            setTimelines(NO_TIMELINES);
            setRoomDoors(NO_ROOM_DOORS);
            // Corridor-only lane, cached exactly as the failure path does.
            writeHotelDataAtEpoch(locale, {
              doors: corridorDoors,
              roomDoors: NO_ROOM_DOORS,
              timelines: NO_TIMELINES,
            }, request);
          } else {
            const entryById = new Map(
              skeleton.map((entry) => [entry.id, entry]),
            );
            // The strand hotels (HD4): each strand's path (chronological)
            // becomes a corridor door list, newest first like the core
            // corridor. Labels come from the skeleton entry when one exists;
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
            const roomDoorMap = buildRoomDoorMap({
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
            });
            setRoomDoors(roomDoorMap);
            // The full lane is derived — cache it for the next view switch.
            writeHotelDataAtEpoch(locale, {
              doors: corridorDoors,
              roomDoors: roomDoorMap,
              timelines: strandTimelines,
            }, request);
          }
        } catch (err) {
          if (!isCurrent()) return;
          if (!warnedStrandFailure) {
            warnedStrandFailure = true;
            console.warn(
              "[game] getStrandPaths failed; rooms render without strand doors",
              err,
            );
          }
          // Strand read failed: cache the corridor-only lane so a view
          // switch still avoids re-fetching the skeleton (the strand map
          // degrades to empty, exactly as the live state does).
          setRoomDoors(NO_ROOM_DOORS);
          setTimelines(NO_TIMELINES);
          writeHotelDataAtEpoch(locale, {
            doors: corridorDoors,
            roomDoors: NO_ROOM_DOORS,
            timelines: NO_TIMELINES,
          }, request);
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (!warnedCatalogFailure) {
          warnedCatalogFailure = true;
          console.warn(
            "[game] getTimelineSkeleton failed; keeping the lobby open",
            err,
          );
        }
        setDoors(EMPTY_DOORS);
        setRoomDoors(NO_ROOM_DOORS);
        setTimelines(NO_TIMELINES);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale, galleryDoors, cacheScope, persona, dataGeneration]);

  return (
    <div className="relative h-full w-full">
      {/* Top-left overlay: title + exit. The container is pointer-transparent
          so it never blocks walking; only the button re-enables pointer
          events. Exit is a WORLD SWITCH now (§14), not a navigation. Hidden
          with the simulation while the document tier sits over the world. */}
      {!suspended && (
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-4 py-4 sm:px-8 sm:py-6">
        <Link href="/" className="scene-wordmark pointer-events-auto inline-flex h-9 items-center">Previously.</Link>
        <div className="flex items-center gap-2">
          <p className="mr-2 hidden max-w-56 truncate text-right text-xs text-muted-foreground sm:block" data-game-scenario>
            {activeScenario
              ? `${t("scenario")} · ${doors?.find((door) => door.sliceId === activeScenario)?.label ?? activeScenario}`
              : t("lobby")}
          </p>
          <button
            type="button"
            data-game-manuscripts
            onClick={onExit}
            className="pointer-events-auto h-9 rounded-full border border-tool-line bg-tool/85 px-4 text-xs text-foreground shadow-float backdrop-blur-md transition hover:bg-tool"
          >
            {t("manuscripts")}
          </button>
          <div className="pointer-events-auto"><NavOverflowMenu /></div>
        </div>
      </header>
      )}
      {/* DEV: the gallery switcher — below the right-hand chrome, clear of
          the conversation pill and the door HUD (bottom-centre).
          It rewrites the query the gallery mode is read from, so the pages
          are one tap away instead of a typed URL, and the hotel is one tap
          back. */}
      {!suspended && galleryDoors !== null && (
      <div className="absolute right-4 top-20 z-20 flex flex-col items-end gap-1 sm:right-6">
        <button
          type="button"
          onClick={() => setGallery(galleryDoors ? null : galleryPage)}
          className="pointer-events-auto rounded-full bg-black/50 px-3 py-1.5 text-[11px] font-medium text-neutral-200 backdrop-blur-sm transition-colors hover:bg-black/65"
        >
          {galleryDoors ? "返回酒店 · Hotel" : "展厅 · Gallery"}
        </button>
        {galleryDoors && (
          <div className="flex flex-col gap-1 rounded-xl bg-black/45 p-1.5 backdrop-blur-sm">
            {(["modules", "templates", "archetypes"] as const).map((page) => (
              <button
                key={page}
                type="button"
                onClick={() => setGallery(page)}
                className={`rounded-lg px-2.5 py-1 text-left text-[11px] transition-colors ${
                  page === galleryPage
                    ? "bg-white/15 text-neutral-100"
                    : "text-neutral-300 hover:bg-white/10 hover:text-neutral-100"
                }`}
              >
                {page === "modules"
                  ? `模块 · Modules (${debugUnitsFor("modules").length})`
                  : page === "templates"
                    ? `模板 · Templates (${debugUnitsFor("templates").length})`
                    : `原型 · Archetypes (${debugUnitsFor("archetypes").length})`}
              </button>
            ))}
          </div>
        )}
      </div>
      )}
      {doors ? (
        <GameCanvas
          persona={persona}
          sourceScope={sourceScope}
          doors={doors}
          roomDoors={roomDoors}
          timelines={timelines}
          focusSlice={focusSlice}
          onOpenDoc={onOpenDoc}
          onActiveSliceChange={setActiveScenario}
          onRoomSnapshotChange={onRoomSnapshotChange}
          suspended={suspended}
          // The product uses a fixed RTS camera. Only an explicit debug
          // query can compare the former chase view.
          cameraMode={cameraModeFor(searchParams.get(CAMERA_PARAM))}
        />
      ) : (
        <GameLoading />
      )}
    </div>
  );
}
