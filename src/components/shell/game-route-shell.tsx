"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GameShell } from "@/components/game/game-shell";
import { WorldCanvas } from "@/components/timeline-3d/world-canvas";
import { WorldSceneProvider } from "@/components/timeline-3d/world-slot";
import { WORLD_TRANSITION } from "@/lib/timeline3d/world-transition";
import { invalidateHotelData } from "@/lib/game/hotel-data";
import type { RoomSnapshot } from "@/lib/game/room-snapshot";
import { useNativeSourceScope } from "@/components/chat/native-source-scope";
import {
  useShell,
  type WorldDriver,
  type WorldPose,
} from "@/components/shell/shell-provider";

export function GameRouteShell({ active }: { active: boolean }) {
  const searchParams = useSearchParams();
  const persona = searchParams.get("persona") ?? "user";
  const sourceScope = useNativeSourceScope();
  const lane = JSON.stringify([sourceScope, persona]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const liveLaneRef = useRef(lane);
  liveLaneRef.current = lane;
  const roomSnapshotRef = useRef<{ lane: string; snapshot: RoomSnapshot | null } | null>(null);
  const [dataGeneration, setDataGeneration] = useState(0);
  const {
    sharedSlice,
    deskDoc,
    worldFrozen,
    screen,
    openDesk,
    openConversation,
    registerWorldDriver,
    setWorldPose,
  } = useShell();
  const deskDocRef = useRef(deskDoc);
  deskDocRef.current = deskDoc;

  const getRoomSnapshot = useCallback(() => {
    if (!activeRef.current) return null;
    const current = roomSnapshotRef.current;
    return current?.lane === liveLaneRef.current ? current.snapshot : null;
  }, []);

  const getPose = useCallback((): WorldPose => ({
    settled: "game",
    suspended: !activeRef.current,
  }), []);

  const refreshCatalog = useCallback(() => {
    invalidateHotelData();
    setDataGeneration((generation) => generation + 1);
  }, []);

  const driver = useMemo<WorldDriver>(() => ({
    standAtSlice: () => undefined,
    getPose,
    getRoomSnapshot,
    onTurnSettled: refreshCatalog,
  }), [getPose, getRoomSnapshot, refreshCatalog]);

  useEffect(() => {
    registerWorldDriver(driver);
    return () => registerWorldDriver(null);
  }, [driver, registerWorldDriver]);

  useEffect(() => {
    setWorldPose({ settled: "game", suspended: !active });
    return () => setWorldPose(null);
  }, [active, setWorldPose]);

  useEffect(() => {
    WORLD_TRANSITION.hooks.enter = (sliceId) => {
      openDesk(`records/${sliceId}`, "manual");
    };
    return () => { WORLD_TRANSITION.hooks.enter = null; };
  }, [openDesk]);

  const onRoomSnapshotChange = useCallback((snapshot: RoomSnapshot | null) => {
    if (liveLaneRef.current !== lane) return;
    if (snapshot) roomSnapshotRef.current = { lane, snapshot };
    if (!activeRef.current || !snapshot) {
      screen.roomLeft();
      return;
    }
    if (deskDocRef.current === null && screen.getScreenContext()?.current?.kind !== "task") {
      screen.roomEntered({ sliceId: snapshot.sliceId, origin: "observed" });
    }
  }, [lane, screen]);

  return (
    <WorldSceneProvider>
      <div className="absolute inset-0">
        <WorldCanvas
          worlds={["game"]}
          paused={!active || worldFrozen}
          suspended={!active}
          band={null}
        />
        <div className="relative h-full w-full">
          <GameShell
            key={lane}
            persona={persona}
            sourceScope={sourceScope}
            dataGeneration={dataGeneration}
            onRoomSnapshotChange={onRoomSnapshotChange}
            onExit={openConversation}
            focusSlice={sharedSlice}
            suspended={!active}
            onOpenDoc={(ref) => openDesk(ref, "manual")}
          />
        </div>
      </div>
    </WorldSceneProvider>
  );
}
