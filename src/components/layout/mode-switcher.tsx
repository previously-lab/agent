"use client";

/**
 * The header mode switcher (v0.11 shell refactor) — a segmented pill
 * 「对话 · 时间线」 centered in the header. The view is now selected by the
 * `?view=timeline` search param on the single `/` route, so the active segment
 * follows the URL and the pill remains a first-class view switch (deep-linkable,
 * refresh-safe, browser-back returns to the chat).
 *
 * Switching to the timeline carries the reading position: the slice at the top
 * of the chat stream's viewport (viewport-slice.ts) rides along as `?at=...`
 * so the 3D camera docks at the node the user was reading. Switching back to
 * chat pushes `/`.
 *
 * `Cmd/Ctrl+.` toggles the mode (parallel to Cmd+K search). The shortcut lives
 * only on the header instance (`enableShortcut`).
 */
import { useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { MessageSquare, Waypoints } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import {
  modeFromSearch,
  timelineHref,
  chatHref,
} from "@/lib/chat/mode-switch";
import { getViewportSlice } from "@/lib/chat/viewport-slice";

export function ModeSwitcher({
  enableShortcut = true,
  /** The 3D scene is always dark — a nested instance (no longer an overlay)
   *  can pin the dark tone regardless of the UI theme. */
  tone = "auto",
}: {
  enableShortcut?: boolean;
  tone?: "auto" | "dark";
}) {
  const t = useTranslations("nav.mode");
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = modeFromSearch(searchParams.toString());

  const goChat = useCallback(() => {
    if (mode !== "chat") router.replace(chatHref(null));
  }, [mode, router]);

  const goTimeline = useCallback(() => {
    if (mode !== "timeline") router.push(timelineHref(getViewportSlice()));
  }, [mode, router]);

  useEffect(() => {
    if (!enableShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      e.preventDefault();
      // Read the live URL, not the `mode` render value: right after a soft
      // navigation the searchParams prop can lag the address bar by a commit,
      // and a stale closure would re-push the route we're already on.
      const inTimeline =
        modeFromSearch(window.location.search) === "timeline";
      router.push(inTimeline ? chatHref(null) : timelineHref(getViewportSlice()));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableShortcut, router]);

  const wrapTone =
    tone === "dark"
      ? "border-white/15 bg-white/5"
      : "border-border/60 bg-muted/40";
  const activeTone =
    tone === "dark"
      ? "bg-white/15 text-zinc-100 shadow-sm"
      : "bg-background text-foreground shadow-sm";
  const idleTone =
    tone === "dark"
      ? "text-zinc-400 hover:text-zinc-100"
      : "text-muted-foreground hover:text-foreground";

  const segment = (
    active: boolean,
    onClick: () => void,
    label: string,
    Icon: typeof MessageSquare,
  ) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors ${
        active ? activeTone : idleTone
      }`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  return (
    <div
      role="group"
      aria-label={t("label")}
      title={`${t("label")} (⌘.)`}
      className={`flex items-center rounded-full border p-0.5 text-xs ${wrapTone}`}
    >
      {segment(mode === "chat", goChat, t("chat"), MessageSquare)}
      {segment(mode === "timeline", goTimeline, t("timeline"), Waypoints)}
    </div>
  );
}
