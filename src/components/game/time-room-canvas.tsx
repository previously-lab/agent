"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type JSX,
  type MutableRefObject,
} from "react";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import { useTheme } from "@teispace/next-themes";
import { useTranslations } from "next-intl";

import { getRoomPapers, type RoomPaper } from "@/lib/archive/actions";
import { CURSOR_HOOKS } from "@/lib/timeline3d/cursor";
import { WORLD_TRANSITION } from "@/lib/timeline3d/world-transition";
import {
  CHASE_LIVE,
  moveBasisFor,
  roomSolids,
  type GameCameraMode,
} from "@/lib/game/chase-camera";
import { clampToSpace, WALL_Z } from "@/lib/game/clamps";
import { hotelDataEpoch } from "@/lib/game/hotel-data";
import type { DoorRef } from "@/lib/game/hotel";
import { scaledRecipeFor } from "@/lib/game/room-plan";
import { NEUTRAL_ROOM_PROFILE, type RoomProfile } from "@/lib/game/room-profile";
import { getBrowserRoomProfileCache } from "@/lib/game/room-profile-cache";
import { decideGate, roomProfileSourceScope } from "@/lib/game/room-intent";
import {
  ROOM_SNAPSHOT_GENERATOR_VERSION,
  type RoomSnapshot,
} from "@/lib/game/room-snapshot";
import {
  TIME_ROOM_ID,
  normalizeTimeZone,
  selectFrozenRoomFrame,
  timeRoomAtmosphere,
  timeRoomAtmosphereKey,
  timeRoomNavigation,
  timeRoomRecipe,
  type CommittedTimeRoomFrame,
  type TimeRoomAtmosphere,
  type TimeRoomEntry,
  type TimeRoomNavigation,
} from "@/lib/game/time-room";
import { waterSideFor } from "@/lib/game/terrain";
import { scaledWallHeight } from "@/lib/game/room-plan";
import { ROOM_WALL_THICKNESS } from "@/lib/game/tuning/room";
import {
  AO_DISTANCE_FALLOFF,
  AO_INTENSITY,
  AO_RADIUS,
  PLAYER_SPEED,
  POST_MSAA_SAMPLES,
} from "@/lib/game/tuning/render";
import { useWorldScene } from "@/components/timeline-3d/world-slot";

import {
  Atmosphere,
  CameraRig,
  FrozenGameFrameRepaint,
  Hud,
  MAX_DT,
  PlayerAvatar,
  TouchControls,
  moveVectorFromKeys,
  roomGeometryForSpace,
  roomSpeedFactor,
  type ActiveSpace,
  type Motion,
  type PaperHud,
  type PlayerRef,
  type WalkTarget,
} from "./game-canvas";
import { GAME_DEBUG } from "./debug";
import { GameTimeOwner, useGameFrame } from "./use-game-frame";
import { gameElapsed, subscribeGameFrozen } from "./game-time";
import { GAME_SIM_FREEZE } from "./sim-freeze";
import type { RoomPaperItem } from "./room-papers";
import { MOUNT_TRACE, SpaceScene } from "./space";

const ROOM_DOOR: DoorRef = {
  index: 0,
  side: "north",
  sliceId: TIME_ROOM_ID,
  x: 0,
  z: WALL_Z,
};

const HANDLED_KEYS = new Set([
  "w", "a", "s", "d",
  "arrowup", "arrowleft", "arrowdown", "arrowright",
]);

interface TimeRoomGeometry {
  plan: ReturnType<typeof roomGeometryForSpace>["plan"];
  doors: ReturnType<typeof roomGeometryForSpace>["doors"];
  seams: ReturnType<typeof roomGeometryForSpace>["seams"];
}

/** Movement and paper proximity for the persistent room. No door manager. */
function TimeRoomLoop({
  activeSpace,
  geometry,
  papers,
  playerRef,
  keysRef,
  motionRef,
  walkRef,
  suspended,
  paperHudRef,
  setPaperHud,
}: {
  activeSpace: ActiveSpace;
  geometry: TimeRoomGeometry;
  papers: readonly RoomPaperItem[];
  playerRef: PlayerRef;
  keysRef: MutableRefObject<Set<string>>;
  motionRef: MutableRefObject<Motion>;
  walkRef: MutableRefObject<WalkTarget>;
  suspended: boolean;
  paperHudRef: MutableRefObject<PaperHud | null>;
  setPaperHud: (paper: PaperHud | null) => void;
}): null {
  useGameFrame((_, { delta }) => {
    const p = playerRef.current;
    const blocked = suspended || WORLD_TRANSITION.active || GAME_SIM_FREEZE.frozen;
    if (!blocked) {
      const keys = moveVectorFromKeys(keysRef.current);
      let rx = keys.rx + CHASE_LIVE.stickX;
      let up = keys.up + CHASE_LIVE.stickY;
      const manual = rx !== 0 || up !== 0;
      const walk = walkRef.current;
      let move = { x: 0, z: 0 };
      if (manual) {
        const length = Math.hypot(rx, up);
        if (length > 1) {
          rx /= length;
          up /= length;
        }
        const basis = moveBasisFor(CHASE_LIVE.yaw);
        move = {
          x: up * basis.fx + rx * basis.rx,
          z: up * basis.fz + rx * basis.rz,
        };
        if (walk.active) {
          walk.active = false;
          CHASE_LIVE.walking = false;
        }
      } else if (walk.active) {
        const dx = walk.x - p.x;
        const dz = walk.z - p.z;
        const distance = Math.hypot(dx, dz);
        if (distance <= walk.arrive) {
          walk.active = false;
          CHASE_LIVE.walking = false;
        } else {
          move = { x: dx / distance, z: dz / distance };
          const step = Math.min(delta, MAX_DT);
          if (Math.abs(walk.lastD - distance) < 0.002) {
            walk.still += step;
            if (walk.still > 0.8) {
              walk.active = false;
              CHASE_LIVE.walking = false;
            }
          } else {
            walk.still = 0;
          }
          walk.lastD = distance;
        }
      }
      const moving = move.x !== 0 || move.z !== 0;
      motionRef.current = { x: move.x, z: move.z, moving };
      if (moving) {
        const step = Math.min(delta, MAX_DT);
        const speed = PLAYER_SPEED * roomSpeedFactor(activeSpace.scale.factor);
        p.x += move.x * speed * step;
        p.z += move.z * speed * step;
        clampToSpace(
          p,
          activeSpace.door,
          activeSpace.scaledRecipe.width,
          activeSpace.scaledRecipe.size.extent,
          geometry.doors,
          geometry.plan,
          geometry.seams,
        );
        // The normal path has no corridor or exit door. Keep the player in
        // the same room even when they walk toward its former entrance.
        p.z = Math.max(p.z, activeSpace.door.z + 0.35);
      }
    } else {
      walkRef.current.active = false;
      CHASE_LIVE.walking = false;
      motionRef.current = { x: 0, z: 0, moving: false };
    }

    let nearest: PaperHud | null = null;
    let best = 1.6;
    for (const paper of papers) {
      const x = activeSpace.door.x + paper.spot.x;
      const z = activeSpace.door.z + paper.spot.z;
      const distance = Math.hypot(p.x - x, p.z - z);
      if (distance <= best) {
        best = distance;
        nearest = { ref: paper.ref, title: paper.title, x, z };
      }
    }
    if (paperHudRef.current?.ref !== nearest?.ref) {
      paperHudRef.current = nearest;
      setPaperHud(nearest);
    }

    GAME_DEBUG.x = p.x;
    GAME_DEBUG.z = p.z;
    GAME_DEBUG.space = activeSpace.snapshot.sliceId;
    GAME_DEBUG.snapshot = activeSpace.snapshot;
    GAME_DEBUG.elapsed = gameElapsed();
    GAME_DEBUG.hotel = TIME_ROOM_ID;
  });
  return null;
}

interface TimeRoomFrame {
  space: ActiveSpace | null;
  papers: readonly RoomPaperItem[];
  navigation: TimeRoomNavigation;
  atmosphere: TimeRoomAtmosphere;
}

/** Keep the last committed room intact while any shared freeze is active. */
function useFrozenRoomFrame(
  live: TimeRoomFrame,
  frozen: boolean,
  laneKey: string,
): TimeRoomFrame {
  const committedRef = useRef<CommittedTimeRoomFrame<TimeRoomFrame> | null>(null);
  useLayoutEffect(() => {
    if (!frozen) committedRef.current = { frame: live, laneKey };
  }, [frozen, laneKey, live]);
  return selectFrozenRoomFrame(committedRef.current, live, frozen, laneKey);
}

export default function TimeRoomCanvas({
  entries,
  focusSlice = null,
  onActiveSliceChange,
  onRoomSnapshotChange,
  onOpenDoc,
  persona = "user",
  sourceScope = roomProfileSourceScope(),
  cameraMode = "chase",
  timeZone = "UTC",
  suspended = false,
  paused = false,
}: {
  /** Newest first, matching GameShell's timeline data lane. */
  entries: readonly TimeRoomEntry[];
  focusSlice?: string | null;
  onActiveSliceChange?: (sliceId: string | null) => void;
  onRoomSnapshotChange?: (snapshot: RoomSnapshot | null) => void;
  onOpenDoc?: (ref: string) => void;
  persona?: string;
  sourceScope?: string;
  cameraMode?: GameCameraMode;
  /** IANA timezone matching the shell's local date labels. */
  timeZone?: string;
  suspended?: boolean;
  /** Shared conversation pause supplied by GameRouteShell. */
  paused?: boolean;
}): JSX.Element {
  const t = useTranslations("game");
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const [simFrozen, setSimFrozen] = useState(GAME_SIM_FREEZE.frozen);
  useEffect(() => subscribeGameFrozen(setSimFrozen), []);
  const frozen = suspended || paused || simFrozen;
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const [requestedSlice, setRequestedSlice] = useState<string | null>(focusSlice);
  const [currentSlice, setCurrentSlice] = useState<string | null>(null);
  useEffect(() => {
    if (!frozen) setRequestedSlice(focusSlice);
  }, [focusSlice, frozen]);
  const liveNavigation = useMemo(
    () => timeRoomNavigation(entries, requestedSlice, currentSlice),
    [entries, requestedSlice, currentSlice],
  );
  const liveActiveSliceId = liveNavigation.active?.sliceId ?? null;
  const normalizedTimeZone = useMemo(() => normalizeTimeZone(timeZone), [timeZone]);
  const liveAtmosphere = useMemo(
    () => timeRoomAtmosphere(liveActiveSliceId ?? TIME_ROOM_ID, normalizedTimeZone),
    [liveActiveSliceId, normalizedTimeZone],
  );

  const profileCache = getBrowserRoomProfileCache();
  const profileEpoch = hotelDataEpoch();
  const profileScopeKey = JSON.stringify([sourceScope, persona, liveActiveSliceId, profileEpoch]);
  const [profilePack, setProfilePack] = useState<{
    key: string;
    sliceId: string;
    profile: RoomProfile;
  } | null>(null);
  const pendingProfileRef = useRef<typeof profilePack>(null);
  useEffect(() => {
    if (!liveActiveSliceId) {
      setProfilePack(null);
      pendingProfileRef.current = null;
      return;
    }
    if (frozen) return;
    let live = true;
    const request = profileCache.capture(sourceScope, persona, liveActiveSliceId);
    const commit = (nextProfile: RoomProfile) => {
      const pack = { key: profileScopeKey, sliceId: liveActiveSliceId, profile: nextProfile };
      if (frozenRef.current) pendingProfileRef.current = pack;
      else setProfilePack(pack);
    };
    void profileCache.load(request).then((result) => {
      if (!live || !profileCache.isCurrent(request)) return;
      const verdict = decideGate(result);
      commit(verdict.kind === "commit" ? verdict.profile : NEUTRAL_ROOM_PROFILE);
    }).catch(() => {
      if (live) commit(NEUTRAL_ROOM_PROFILE);
    });
    return () => { live = false; };
  }, [liveActiveSliceId, persona, sourceScope, profileEpoch, profileCache, profileScopeKey, frozen]);
  useEffect(() => {
    if (frozen) return;
    const pending = pendingProfileRef.current;
    if (pending?.key === profileScopeKey) setProfilePack(pending);
    pendingProfileRef.current = null;
  }, [frozen, profileScopeKey]);
  const profile = profilePack?.key === profileScopeKey
    ? profilePack.profile
    : NEUTRAL_ROOM_PROFILE;

  const liveSpace = useMemo<ActiveSpace | null>(() => {
    if (!liveActiveSliceId) return null;
    const recipe = timeRoomRecipe(liveActiveSliceId, normalizedTimeZone);
    const { recipe: scaledRecipe, scale } = scaledRecipeFor(recipe, 0);
    return {
      door: ROOM_DOOR,
      recipe,
      scaledRecipe,
      scale,
      roomDoorCount: 0,
      snapshot: Object.freeze({
        sliceId: liveActiveSliceId,
        generatorVersion: ROOM_SNAPSHOT_GENERATOR_VERSION,
        profile,
        roomId: TIME_ROOM_ID,
        timezone: normalizedTimeZone,
      }),
    };
  }, [liveActiveSliceId, normalizedTimeZone, profile]);
  const liveGeometry = useMemo(
    () => liveSpace ? roomGeometryForSpace(liveSpace, 0) : null,
    [liveSpace],
  );

  const papersScopeKey = JSON.stringify([sourceScope, persona, liveActiveSliceId]);
  const [papersPack, setPapersPack] = useState<{
    key: string;
    sliceId: string;
    papers: RoomPaper[];
  } | null>(null);
  const pendingPapersRef = useRef<typeof papersPack>(null);
  useEffect(() => {
    if (!liveActiveSliceId) {
      setPapersPack(null);
      pendingPapersRef.current = null;
      return;
    }
    if (frozen) return;
    let live = true;
    const commit = (nextPapers: RoomPaper[]) => {
      const pack = { key: papersScopeKey, sliceId: liveActiveSliceId, papers: nextPapers };
      if (frozenRef.current) pendingPapersRef.current = pack;
      else setPapersPack(pack);
    };
    getRoomPapers(liveActiveSliceId, persona)
      .then((nextPapers) => { if (live) commit(nextPapers); })
      .catch(() => { if (live) commit([]); });
    return () => { live = false; };
  }, [liveActiveSliceId, persona, sourceScope, papersScopeKey, frozen]);
  useEffect(() => {
    if (frozen) return;
    const pending = pendingPapersRef.current;
    if (pending?.key === papersScopeKey) setPapersPack(pending);
    pendingPapersRef.current = null;
  }, [frozen, papersScopeKey]);
  const livePapers = useMemo<RoomPaperItem[]>(() => {
    if (!liveActiveSliceId || !liveGeometry || papersPack?.key !== papersScopeKey) return [];
    return papersPack.papers.flatMap((paper, index) => {
      const spot = liveGeometry.paperSpots[index];
      return spot ? [{ spot, ref: paper.ref, title: paper.title, date: paper.date }] : [];
    });
  }, [liveActiveSliceId, liveGeometry, papersPack, papersScopeKey]);

  const laneKey = JSON.stringify([sourceScope, persona]);
  const frame = useFrozenRoomFrame({
    space: liveSpace,
    papers: livePapers,
    navigation: liveNavigation,
    atmosphere: liveAtmosphere,
  }, frozen, laneKey);
  const activeSpace = frame.space;
  const papers = frame.papers;
  const navigation = frame.navigation;
  const atmosphere = frame.atmosphere;
  const activeEntry = navigation.active;
  const activeSliceId = activeEntry?.sliceId ?? null;
  const geometry = useMemo(
    () => activeSpace ? roomGeometryForSpace(activeSpace, 0) : null,
    [activeSpace],
  );
  const displayedTimeZone = activeSpace?.snapshot.generatorVersion === 2
    ? activeSpace.snapshot.timezone
    : normalizedTimeZone;
  useEffect(() => {
    if (frozen) return;
    setCurrentSlice(activeSliceId);
    onActiveSliceChange?.(activeSliceId);
    if (activeSliceId) CURSOR_HOOKS.report?.(activeSliceId);
  }, [activeSliceId, frozen, onActiveSliceChange]);
  useEffect(() => {
    onRoomSnapshotChange?.(suspended ? null : activeSpace?.snapshot ?? null);
    return () => onRoomSnapshotChange?.(null);
  }, [activeSpace, suspended, onRoomSnapshotChange]);

  const playerRef = useRef({ x: 0, z: WALL_Z + 1.4 });
  const keysRef = useRef(new Set<string>());
  const motionRef = useRef<Motion>({ x: 0, z: 0, moving: false });
  const walkRef = useRef<WalkTarget>({
    active: false,
    x: 0,
    z: 0,
    arrive: 0.3,
    interact: false,
    still: 0,
    lastD: Number.POSITIVE_INFINITY,
  });
  const cameraSnapRef = useRef(true);
  const [paperHud, setPaperHud] = useState<PaperHud | null>(null);
  const paperHudRef = useRef<PaperHud | null>(null);
  const onOpenDocRef = useRef(onOpenDoc);
  onOpenDocRef.current = onOpenDoc;
  const interactRef = useRef<() => void>(() => {});
  useEffect(() => {
    interactRef.current = () => {
      if (frozenRef.current || WORLD_TRANSITION.active) return;
      const paper = paperHudRef.current;
      if (paper) onOpenDocRef.current?.(paper.ref);
    };
  }, []);

  useEffect(() => {
    function targetOwnsKeys(target: EventTarget | null): boolean {
      return target instanceof HTMLElement && (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest("button, a, select, [role='button'], [role='menuitem']") !== null
      );
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (frozenRef.current) return;
      const key = event.key.toLowerCase();
      if ((key === "enter" || key === "e") && !targetOwnsKeys(event.target) && paperHudRef.current) {
        event.preventDefault();
        interactRef.current();
        return;
      }
      if (!HANDLED_KEYS.has(key) || targetOwnsKeys(event.target)) return;
      event.preventDefault();
      keysRef.current.add(key);
    }
    function onKeyUp(event: KeyboardEvent): void {
      keysRef.current.delete(event.key.toLowerCase());
    }
    function onBlur(): void { keysRef.current.clear(); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    if (!frozen) return;
    keysRef.current.clear();
    walkRef.current.active = false;
    CHASE_LIVE.walking = false;
    motionRef.current = { x: 0, z: 0, moving: false };
  }, [frozen]);

  useEffect(() => {
    GAME_DEBUG.papers = papers.map((paper) => ({
      ref: paper.ref,
      x: ROOM_DOOR.x + paper.spot.x,
      z: ROOM_DOOR.z + paper.spot.z,
    }));
  }, [papers]);
  useEffect(() => {
    GAME_DEBUG.teleport = (x, z) => {
      playerRef.current.x = x;
      playerRef.current.z = z;
    };
    GAME_DEBUG.travel = undefined;
    GAME_DEBUG.interact = () => interactRef.current();
    window.__gameDebug = GAME_DEBUG;
    window.__gameMountTrace = MOUNT_TRACE;
    return () => {
      GAME_DEBUG.teleport = undefined;
      GAME_DEBUG.interact = undefined;
      GAME_DEBUG.papers = [];
      GAME_DEBUG.room = null;
      GAME_DEBUG.snapshot = null;
      delete window.__gameDebug;
      delete window.__gameMountTrace;
    };
  }, []);
  useEffect(() => {
    GAME_DEBUG.timeRoom = {
      roomId: TIME_ROOM_ID,
      sliceId: activeSliceId,
      atmosphere: timeRoomAtmosphereKey(atmosphere),
      timezone: displayedTimeZone,
      previousSliceId: navigation.previousIndex === null ? null : navigation.entries[navigation.previousIndex].sliceId,
      nextSliceId: navigation.nextIndex === null ? null : navigation.entries[navigation.nextIndex].sliceId,
    };
  }, [activeSliceId, atmosphere, navigation, displayedTimeZone]);

  const selectSlice = useCallback((sliceId: string) => {
    if (frozenRef.current) return;
    setRequestedSlice(null);
    setCurrentSlice(sliceId);
  }, []);
  const handleTap = useCallback((sx: number, sy: number) => {
    if (frozenRef.current || WORLD_TRANSITION.active) return;
    const point = CHASE_LIVE.projectTap?.(sx, sy);
    if (!point) return;
    let nearest: { ref: string; distance: number } | null = null;
    for (const paper of GAME_DEBUG.papers) {
      const distance = Math.hypot(point.x - paper.x, point.z - paper.z);
      if (distance <= 1.6 && (!nearest || distance < nearest.distance)) {
        nearest = { ref: paper.ref, distance };
      }
    }
    if (nearest) {
      onOpenDocRef.current?.(nearest.ref);
      return;
    }
    walkRef.current = {
      active: true,
      x: point.x,
      z: point.z,
      arrive: 0.3,
      interact: false,
      still: 0,
      lastD: Number.POSITIVE_INFINITY,
    };
    CHASE_LIVE.walkX = point.x;
    CHASE_LIVE.walkZ = point.z;
    CHASE_LIVE.walking = true;
  }, []);

  const cameraSolids = useMemo(() => {
    if (!activeSpace || !geometry) return [];
    const factor = activeSpace.scale.factor;
    return roomSolids({
      door: activeSpace.door,
      plan: geometry.plan,
      wallThick: ROOM_WALL_THICKNESS * Math.max(factor, 0.35),
      wallHeight: scaledWallHeight(factor),
      seams: geometry.seams,
      terminal: null,
    });
  }, [activeSpace, geometry]);
  const waterSide = activeSpace ? waterSideFor(activeSpace.scaledRecipe) : 0;
  const [frozenFrameComposer, setFrozenFrameComposer] =
    useState<ComponentRef<typeof EffectComposer> | null>(null);
  const frozenFrameComposerRef = useCallback(
    (composer: ComponentRef<typeof EffectComposer> | null) => setFrozenFrameComposer(composer),
    [],
  );

  useWorldScene("game", <>
    <GameTimeOwner />
    {activeSpace && geometry && <>
      <Atmosphere space={activeSpace} dark={dark} playerRef={playerRef} />
      <CameraRig
        playerRef={playerRef}
        motionRef={motionRef}
        space={activeSpace}
        snapRef={cameraSnapRef}
        mode={cameraMode}
        solids={cameraSolids}
        waterSide={waterSide}
      />
      <PlayerAvatar
        playerRef={playerRef}
        motionRef={motionRef}
        space={activeSpace}
        waterSide={waterSide}
      />
      <SpaceScene
        key={TIME_ROOM_ID}
        recipe={activeSpace.recipe}
        door={activeSpace.door}
        playerRef={playerRef}
        corridorGone
        fade="in"
        onFadedOut={() => {}}
        roomDoorCount={0}
        papers={papers}
        showEntrance={false}
        timeAtmosphere={atmosphere}
      />
      <TimeRoomLoop
        activeSpace={activeSpace}
        geometry={geometry}
        papers={papers}
        playerRef={playerRef}
        keysRef={keysRef}
        motionRef={motionRef}
        walkRef={walkRef}
        suspended={frozen}
        paperHudRef={paperHudRef}
        setPaperHud={setPaperHud}
      />
    </>}
    <EffectComposer
      ref={frozenFrameComposerRef}
      enabled={!frozen}
      multisampling={POST_MSAA_SAMPLES}
    >
      <N8AO
        halfRes
        quality="performance"
        intensity={AO_INTENSITY}
        aoRadius={AO_RADIUS}
        distanceFalloff={AO_DISTANCE_FALLOFF}
      />
    </EffectComposer>
    <FrozenGameFrameRepaint suspended={frozen} composer={frozenFrameComposer} />
  </>);

  return (
    <div
      className="relative h-full w-full"
      data-game-slice={activeSliceId ?? ""}
      data-game-atmosphere={timeRoomAtmosphereKey(atmosphere)}
      data-game-timezone={displayedTimeZone}
    >
      {!suspended && activeEntry && (
        <nav
          data-game-time-navigation
          aria-label={t("timeHistory")}
          className="absolute left-1/2 top-20 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-tool-line bg-tool/85 p-1 text-xs text-foreground shadow-float backdrop-blur-md"
        >
          <button
            type="button"
            data-game-time-prev
            aria-label={t("timePrevious")}
            disabled={frozen || navigation.previousIndex === null}
            onClick={() => {
              if (navigation.previousIndex !== null) selectSlice(navigation.entries[navigation.previousIndex].sliceId);
            }}
            className="rounded-full px-3 py-1.5 transition hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ←
          </button>
          <span className="min-w-0 max-w-48 truncate px-2 font-serif" aria-live="polite">
            {activeEntry.label}
          </span>
          <button
            type="button"
            data-game-time-next
            aria-label={t("timeNext")}
            disabled={frozen || navigation.nextIndex === null}
            onClick={() => {
              if (navigation.nextIndex !== null) selectSlice(navigation.entries[navigation.nextIndex].sliceId);
            }}
            className="rounded-full px-3 py-1.5 transition hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            →
          </button>
        </nav>
      )}
      {!suspended && !activeEntry && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" role="status">
          <p className="rounded-full border border-tool-line bg-tool/85 px-4 py-2 text-sm text-muted-foreground">
            {t("timeEmpty")}
          </p>
        </div>
      )}
      {!suspended && activeSpace && <>
        <TouchControls onTap={handleTap} />
        <Hud
          door={null}
          anchor={null}
          paper={paperHud}
          enterHint=""
          readHint={t("readDoc")}
          onInteract={() => interactRef.current()}
        />
      </>}
    </div>
  );
}
