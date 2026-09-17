"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { getTimelineCatalog } from "@/lib/episodic/actions";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
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

export function GameShell() {
  const t = useTranslations("game");
  const locale = useLocale();
  const router = useRouter();
  // null = the catalog is still in flight; the corridor mounts only once the
  // doors resolve (to the timeline, or to the fallback on empty/error).
  const [doors, setDoors] = useState<readonly CorridorDoor[] | null>(null);

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
        setDoors(
          catalog
            .slice(-MAX_DOORS)
            .reverse()
            .map((entry) => ({
              sliceId: entry.id,
              label: formatDoorLabel(entry.date, entry.start, locale),
              start: entry.start,
            })),
        );
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") router.push("/");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <div className="relative h-full w-full">
      {/* Top-left overlay: title + exit. The container is pointer-transparent
          so it never blocks walking; only the link re-enables pointer events. */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 sm:left-6 sm:top-6">
        <p className="text-sm font-semibold tracking-tight text-neutral-100">
          {t("title")}
        </p>
        <Link
          href="/"
          className="pointer-events-auto text-xs text-neutral-400 transition-colors hover:text-neutral-200"
        >
          {t("exit")}
        </Link>
      </div>
      {doors ? <GameCanvas doors={doors} /> : <GameLoading />}
    </div>
  );
}
