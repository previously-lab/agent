"use client";

/**
 * PlaygroundRoom — the page body of /{locale}/playground: the control bar
 * (room / skin / seed), the data readout, and the single-room canvas.
 *
 * Every control rewrites the URL (`?m=&skin=&seed=`) and nothing else —
 * the room is a pure function of the query, so a screenshot's address IS
 * its reproduce button. The readout is describeRoom (the same pure chain
 * the renderer builds from) on the SAME slice id the canvas renders, so
 * the numbers and the picture cannot drift apart. Labels are hardcoded
 * bilingual, the gallery switcher's precedent (game-shell.tsx) — this is
 * a dev/acceptance surface, not product chrome, so it adds no i18n keys.
 */

import { useMemo, type JSX } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ROOM_MODULES } from "@/lib/game/room-modules";
import { describeRoom } from "@/lib/game/describe-room";
import { roomSchematicFor } from "@/lib/game/room-schematic";
import {
  PLAYGROUND_SKIN_IDS,
  parsePlaygroundParams,
  playgroundSliceId,
} from "@/lib/game/playground";

const PlaygroundScene = dynamic(() => import("./playground-scene").then((m) => m.PlaygroundScene), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <p className="text-sm text-neutral-400">布置房间 · Setting up the room…</p>
    </div>
  ),
});

/** A deterministic-ish new seed tag (the room's layout stream reads the
 *  string itself — any tag works, uniqueness per click is all we want). */
function nextSeedTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

const SELECT_CLASS =
  "rounded-md bg-white/10 px-2 py-1 text-xs text-neutral-100 outline-none [&>option]:text-neutral-900";

export function PlaygroundRoom(): JSX.Element {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const params = useMemo(
    () =>
      parsePlaygroundParams({
        m: searchParams.get("m"),
        skin: searchParams.get("skin"),
        seed: searchParams.get("seed"),
      }),
    [searchParams],
  );
  const sliceId = playgroundSliceId(params);

  /** Rewrite one param and drop it when cleared — the URL stays the whole
   *  state, so null means "delete the key". */
  const setParam = (key: "m" | "skin" | "seed", value: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // THE READOUT — the renderer's own pure chain on the same slice id.
  const description = useMemo(() => describeRoom(sliceId), [sliceId]);
  const schematic = roomSchematicFor(params.moduleId);
  const furnishing = description.furnishing ?? [];
  const schematicKits = furnishing.filter((f) =>
    f.kit.startsWith(`${params.moduleId}:`),
  );
  const genericKits = furnishing.filter(
    (f) => !f.kit.startsWith(`${params.moduleId}:`),
  );
  const pieceTotal = furnishing.reduce((n, f) => n + f.pieces.length, 0);

  return (
    <div className="fixed inset-0">
      <div className="absolute inset-0">
        <PlaygroundScene sliceId={sliceId} />
      </div>

      {/* CONTROLS — bottom-left, clear of the app chrome's top islands. */}
      <div className="absolute bottom-4 left-4 z-10 flex flex-wrap items-center gap-2 rounded-xl bg-black/50 p-2.5 text-neutral-200 backdrop-blur-sm sm:bottom-6 sm:left-6">
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          房间 · Room
          <select
            className={SELECT_CLASS}
            value={params.moduleId}
            onChange={(e) => setParam("m", e.target.value)}
          >
            {ROOM_MODULES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          皮肤 · Skin
          <select
            className={SELECT_CLASS}
            value={params.skinId ?? ""}
            onChange={(e) => setParam("skin", e.target.value || null)}
          >
            <option value="">无（基线）· none</option>
            {PLAYGROUND_SKIN_IDS.filter((id) => id !== "temperate").map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setParam("seed", nextSeedTag())}
          className="rounded-md bg-white/10 px-2.5 py-1 text-xs transition-colors hover:bg-white/20"
        >
          换种子 · New seed
        </button>
        {params.seedTag !== null && (
          <span className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] text-neutral-300">
            seed={params.seedTag}
            <button
              type="button"
              aria-label="清除种子 · clear seed"
              onClick={() => setParam("seed", null)}
              className="text-neutral-500 transition-colors hover:text-neutral-200"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {/* READOUT — right side: the room's facts, next to its picture. */}
      <aside className="absolute bottom-4 right-4 top-16 z-10 w-72 overflow-y-auto rounded-xl bg-black/50 p-3 text-[11px] leading-relaxed text-neutral-300 backdrop-blur-sm sm:bottom-6 sm:right-6">
        <dl className="space-y-3">
          <section>
            <dt className="font-semibold text-neutral-100">身份 · Identity</dt>
            <dd className="mt-0.5 break-all font-mono text-neutral-400">{sliceId}</dd>
            <dd>
              {params.moduleId} · {description.sizeTier} · plan {description.width}×
              {description.extent} m（{description.plan.id}）
              {description.water
                ? ` · 水 ${description.water.width}×${description.water.depth} m`
                : ""}
            </dd>
            <dd>
              palette {description.palette} · 光 {description.lightRegister}
              {description.skin ? ` · 皮肤 ${description.skin.id}` : " · 无皮肤（温带基线）"}
            </dd>
          </section>

          <section>
            <dt className="font-semibold text-neutral-100">
              蓝图路径 · Schematic
            </dt>
            <dd className="mt-0.5">
              {schematic
                ? `有蓝图（${schematic.moduleId}，${schematic.slots.length} 槽）· blueprint authored`
                : "无蓝图 · no blueprint"}
              {" → "}
              {schematicKits.length > 0 ? (
                <span className="text-emerald-300">
                  已走蓝图：{schematicKits.map((f) => f.kit.split(":")[1]).join(", ")}
                </span>
              ) : schematic ? (
                <span className="text-amber-300">
                  未命中，回退泛用布置 · fell back to generic staging
                </span>
              ) : (
                <span>泛用布置 · generic staging</span>
              )}
            </dd>
            {description.layout.kind === "modules" ? (
              <dd>
                模块组合 · composition {description.layout.topology}:{" "}
                {description.layout.modules
                  .map((m) => `${m.label}${m.primary ? "*" : ""}`)
                  .join(" / ")}
                {description.layout.seams > 0
                  ? ` · ${description.layout.seams} 缝`
                  : ""}
              </dd>
            ) : (
              <dd>layout {description.layout.kind}</dd>
            )}
          </section>

          <section>
            <dt className="font-semibold text-neutral-100">
              家具 · Furnishing（{pieceTotal} 件 · pieces）
            </dt>
            <dd className="mt-0.5 space-y-1">
              {furnishing.length === 0 && (
                <p className="text-neutral-500">（这间房没有家具清单 · no kits staged）</p>
              )}
              {[...schematicKits, ...genericKits].map((f) => (
                <p key={f.kit} className="break-all">
                  <span
                    className={
                      f.kit.startsWith(`${params.moduleId}:`)
                        ? "text-emerald-300"
                        : "text-neutral-400"
                    }
                  >
                    {f.kit}
                  </span>{" "}
                  — {summarizePieces(f.pieces)}
                </p>
              ))}
            </dd>
          </section>

          {description.features.length > 0 && (
            <section>
              <dt className="font-semibold text-neutral-100">
                墙面/地面特征 · Features
              </dt>
              <dd className="mt-0.5">
                {description.features.map((f) => `${f.kind}@${f.at}`).join(", ")}
              </dd>
            </section>
          )}
        </dl>
      </aside>
    </div>
  );
}

/** "sofa, sofa, bookshelf" → "sofa ×2, bookshelf ×1" (first-seen order). */
function summarizePieces(pieces: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const p of pieces) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(", ");
}
