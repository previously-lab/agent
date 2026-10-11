"use client";

/**
 * BoardBar — the middle of the app's top row, and the one that belongs to
 * the WORLD rather than to the app around it.
 *
 *   LEFT    brand inscription       (`layout/app-header.tsx`)
 *   MIDDLE  the board bar           this file — the rung dateline
 *   RIGHT   search + overflow       (`layout/app-header.tsx`)
 *
 * It carries the TWO RUNGS — 现场 · 原稿 (Scene · Manuscript), the world's
 * two faces. The zoom ladder it replaced (对话 · 片 · 日 · 周) retired with the
 * conversation rung: the world is the hotel or the documents, and selecting a
 * rung asks the shell's transition machine for that world — a move, never
 * a snap.
 *
 * ONE INSTRUMENT BAR (v0.29 §4.2, amended by the owner on first look): the
 * segmented pill is still gone — no per-rung backgrounds, no active chrome
 * pill — but the two words sit INSIDE a single `chrome-bar`. The de-contained
 * version was designed against a paper bed; `/app`'s bed is the frozen,
 * blurred world, and bare mono over a picture loses the contrast a control
 * needs. So: the words stay, the `·` stays, the current one still stands at
 * 700 with its 2px ink underline, and the bar around them is the same matte
 * instrument as every other control. The brand inscription stays bare — it is
 * not something the reader has to find, so it does not need a container.
 *
 * THE TRANSITION RULE: while a move is live, the underline LEAVES the old
 * word and grows toward the new one — the shell's transition clock read as
 * print, a progress bar disguised as typography. The clock is the shared
 * singleton `WORLD_TRANSITION` (world-transition.ts): the shell's rAF
 * writes `progress` 0→1 every frame; this bar polls the singleton at a
 * slow interval to learn a move has started (React state — which word is
 * old, which is new), then paints `--p` on the growing rule every frame
 * until the move settles. The growth is eased here (the clock's raw
 * progress is linear) so the line travels like ink, not like a loader.
 *
 * It is mounted by the SHELL, not by either world, because it must exist at
 * either rung. In the hotel the world's own Exit is the way back — the game
 * keeps its viewport clear of product chrome.
 *
 * THE SCENE WORD'S SECOND JOB (v0.30) — the door into the hotel used to be
 * a second, floating gate beside the bar; the bar's own Scene word carries
 * it now. When the reader is NOT in the scene and there is a room to travel
 * to (the shared cursor) or one to return to (the remembered cursor), the
 * word opens the gate's ruling list as a tool panel — the matte square
 * chrome-panel, hairline chrome-rows, the current room an ink block — and
 * choosing enters the scene there. With nothing to choose (or already in
 * the scene, where the world's own doors navigate) the word is the plain
 * rung switch it always was. The list's labels stay inline per-locale,
 * exactly like the old gate's, not message keys.
 */
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import {
  smooth01,
  WORLD_TRANSITION,
} from "@/lib/timeline3d/world-transition";

export interface SceneChoice {
  /** The shared cursor's room — entering travels WITH the cursor. */
  current: string | null;
  /** The remembered cursor — entering restores the room the reader left. */
  remembered: string | null;
}

export interface BoardBarProps {
  /** The rung to light — the settled world, or the destination mid-move. */
  world: WorldKind;
  onSelect: (world: WorldKind) => void;
  /** The scene's room choices — a non-null field makes the Scene word a menu. */
  sceneChoice: SceneChoice;
  /** Enter the hotel at the chosen room (the shell's nav.standAtSlice). */
  onEnterRoom: (sliceId: string) => void;
}

/** The two rungs in the strip's left-to-right order. */
const RUNGS: WorldKind[] = ["game", "field"];

/** How often the strip checks whether a move has started/stopped. The
 *  paint itself is rAF-driven; this only flips the React-visible move
 *  state (which word is old/new), so a coarse clock is fine. */
const MOVE_SYNC_MS = 120;

export function BoardBar({ world, onSelect, sceneChoice, onEnterRoom }: BoardBarProps) {
  const t = useTranslations("rungs");
  const locale = useLocale();
  /** The growing rule's track — `--p` is painted imperatively, no re-render. */
  const lineRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The live move, once one is running — drives the old/new word styling. */
  const [move, setMove] = useState<{ from: WorldKind; to: WorldKind } | null>(
    null,
  );
  /** The Scene word's room menu — open only while the reader is outside
   *  the scene and a room choice exists (see the module header). */
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);

  // The menu's labels are inline per-locale rather than message keys — the
  // same deliberate choice the old world gate made (messages/ belongs to
  // another lane, and this list is the gate's list carried over verbatim).
  const gateText = locale.startsWith("zh")
    ? {
        goThis: "前往这个房间",
        goBack: "回到原来的房间",
        cancel: "取消 · 继续阅读",
      }
    : {
        goThis: "Go to this room",
        goBack: "Back to the previous room",
        cancel: "Cancel · keep reading",
      };

  // ── THE SCENE WORD'S ROOM MENU ──────────────────────────────────────────
  // The old world gate's ruling list, verbatim in behaviour: with a cursor
  // or a remembered room the Scene word offers 前往这个房间 (the travel beat
  // via nav.standAtSlice — the cursor moves) / 回到原来的房间 (the return) /
  // 取消 (stay). Escape closes, an outside pointerdown closes, choosing
  // closes. The gate was FIELD chrome, so the word is a plain rung switch
  // again once the reader is in the scene.
  const hasGoThis = sceneChoice.current !== null;
  const hasGoBack =
    sceneChoice.remembered !== null &&
    sceneChoice.remembered !== sceneChoice.current;
  const menuAvailable = world !== "game" && (hasGoThis || hasGoBack);

  useEffect(() => {
    if (!sceneMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSceneMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sceneMenuOpen]);

  useEffect(() => {
    if (!sceneMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setSceneMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [sceneMenuOpen]);

  // Entering the scene (the toggle, a choice, Ctrl+.) retires the menu: the
  // word becomes the plain rung switch again, so a stale open flag must not
  // resurface the panel on the way back out.
  useEffect(() => {
    if (world === "game") setSceneMenuOpen(false);
  }, [world]);

  useEffect(() => {
    let raf = 0;
    const paint = (): void => {
      lineRef.current?.style.setProperty(
        "--p",
        WORLD_TRANSITION.active ? String(smooth01(WORLD_TRANSITION.progress)) : "0",
      );
    };
    const tick = (): void => {
      if (!WORLD_TRANSITION.active) {
        raf = 0;
        paint();
        return;
      }
      paint();
      raf = requestAnimationFrame(tick);
    };
    const sync = (): void => {
      const wt = WORLD_TRANSITION;
      if (wt.active) {
        setMove((m) =>
          m && m.from === wt.from && m.to === wt.to ? m : { from: wt.from, to: wt.to },
        );
        if (!raf) raf = requestAnimationFrame(tick);
      } else {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        setMove((m) => (m === null ? m : null));
        paint();
      }
    };
    const id = setInterval(sync, MOVE_SYNC_MS);
    return () => {
      clearInterval(id);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // The word at 700: the settled rung, or — mid-move — the word the reader
  // is leaving. The destination lights only when the move settles (the
  // shell flips `world` then), which is exactly the lab's beat stills.
  const current = move ? move.from : world;
  /** The rule grows from the old word's side: 现场 is left, 原稿 is right. */
  const fromLeft = (move ? move.from : world) === "game";

  return (
    // z-50, the same layer as the header: this is chrome, and it must
    // clear anything the worlds paint beneath it.
    //
    // WHERE IT SITS, per breakpoint:
    //
    //   phone   the SECOND line, right-aligned under the header's own — the
    //           header holds the brand and the right pair on its first, and
    //           this bar takes the line beneath both. `top-13` is 52 px:
    //           the header's own `p-2` + `h-9` + `gap-2`, so this bar drops
    //           exactly onto the line the header left for it
    //   md+     the middle of three, all on one line
    <div
      ref={rootRef}
      data-board-bar
      className="pointer-events-none fixed top-13 right-2 z-50 flex max-w-[calc(100vw-1rem)] md:top-4 md:right-auto md:left-1/2 md:-translate-x-1/2"
    >
      <div
        role="group"
        aria-label={t("label")}
        className="chrome-bar chrome-rungs pointer-events-auto px-2 pt-1.5 pb-1"
      >
        {RUNGS.map((key, i) => {
          const label = key === "game" ? t("scene") : t("manuscript");
          const isSceneMenu = key === "game" && menuAvailable;
          return (
            <span key={key} className="inline-flex items-baseline">
              {i > 0 && (
                <span className="chrome-rung-sep" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                type="button"
                aria-pressed={key === world}
                aria-label={label}
                title={label}
                aria-haspopup={isSceneMenu ? "menu" : undefined}
                aria-expanded={isSceneMenu ? sceneMenuOpen : undefined}
                onClick={() => {
                  if (isSceneMenu) setSceneMenuOpen((open) => !open);
                  else onSelect(key);
                }}
                className={`chrome-rung ${key === current ? "is-current" : ""}`}
              >
                {label}
              </button>
            </span>
          );
        })}
        {move && (
          <span
            ref={lineRef}
            aria-hidden="true"
            className={`chrome-rung-line ${fromLeft ? "" : "chrome-rung-line--from-right"}`}
          >
            <i />
          </span>
        )}
      </div>
      {/* The Scene word's room menu — the old world gate's list, rewritten
          as a tool tray: matte square panel, hairline rows, the current
          room an ink block. Anchored to the wrapper's left edge, which is
          the Scene word's own edge at every breakpoint (the word is the
          bar's first). */}
      {menuAvailable && sceneMenuOpen && (
        <div
          role="menu"
          aria-label={t("scene")}
          className="chrome-panel pointer-events-auto absolute top-full left-0 mt-1 flex w-60 flex-col"
        >
          <div className="chrome-panel-head">
            <h2 className="chrome-engraved">{t("scene")}</h2>
          </div>
          {/* The remembered room is the one the reader actually stood in —
              the ink block. With no memory the cursor's room is the only
              address, so it carries the block. */}
          {hasGoThis && (
            <button
              type="button"
              role="menuitem"
              className={`chrome-row px-3.5 py-2 text-xs ${!hasGoBack ? "is-active" : ""}`}
              onClick={() => {
                setSceneMenuOpen(false);
                onEnterRoom(sceneChoice.current!);
              }}
            >
              {gateText.goThis}
            </button>
          )}
          {hasGoBack && (
            <button
              type="button"
              role="menuitem"
              className="chrome-row is-active px-3.5 py-2 text-xs"
              onClick={() => {
                setSceneMenuOpen(false);
                onEnterRoom(sceneChoice.remembered!);
              }}
            >
              {gateText.goBack}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="chrome-row px-3.5 py-2 text-xs"
            onClick={() => setSceneMenuOpen(false)}
          >
            {gateText.cancel}
          </button>
        </div>
      )}
    </div>
  );
}
