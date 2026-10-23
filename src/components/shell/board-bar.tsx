"use client";

import { useTranslations } from "next-intl";
import { ArrowUpRight, Play } from "lucide-react";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface SceneChoice {
  current: string | null;
  remembered: string | null;
}

export interface BoardBarProps {
  world: WorldKind;
  onSelect: (world: WorldKind) => void;
  sceneChoice: SceneChoice;
  canTravel: boolean;
  onEnterRoom: (sliceId: string) => void;
}

/** Reading is a pause in the scene. Resuming preserves its pose; traveling
 * to the document's related room is an explicit, separate action. */
export function BoardBar({ world, onSelect, sceneChoice, canTravel, onEnterRoom }: BoardBarProps) {
  const t = useTranslations("sceneReading");
  if (world === "game") return null;
  const relatedRoom = sceneChoice.current !== null &&
    sceneChoice.current !== sceneChoice.remembered;

  return (
    <div data-board-bar className="scene-pause-controls">
      <button type="button" data-scene-resume className="chrome-island scene-resume" onClick={() => onSelect("game")}>
        <Play aria-hidden className="size-3.5" />
        {t("resume")}
      </button>
      <span className="scene-pause-label">{t("paused")}</span>
      {relatedRoom && (
        <DropdownMenu>
          <DropdownMenuTrigger disabled={!canTravel} className="chrome-island pointer-events-auto flex size-9 items-center justify-center disabled:opacity-50" aria-label={t("relatedRoom")}>
            <ArrowUpRight aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="chrome-panel min-w-52 p-2">
            <DropdownMenuItem disabled={!canTravel} onClick={() => onEnterRoom(sceneChoice.current!)}>
              {t("goToRoom")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
