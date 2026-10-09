"use client";

/**
 * ConversationOverlayMount — the gate and the lazy seat for the conversation
 * overlay (`conversation-overlay.tsx`).
 *
 * WHY DYNAMIC. The overlay statically reaches @react-three/fiber through the
 * conversation field, and this mount is imported by the LAYOUT — shared by
 * every route. Only a dynamic import keeps three.js out of the home route's
 * chunk (v0.13 §3's one hard engineering rule: the home does not hang R3F),
 * while the layout still hosts the layer for every route that wants it.
 * `ssr: false` because the overlay is pure client chrome — and because the
 * pathname gate below must not render different trees on server and client.
 *
 * WHY THE GATE. The home route has NO conversation ability (the reader's
 * ruling: no pill, no subtitle, no fullscreen — the home is a start screen,
 * not a chat window), and the playground is a component gallery an overlay
 * would corrupt. Hiding there UNMOUNTS the layer; that is acceptable exactly
 * because the home is the session's exit (§3's 单向门 — leaving the world
 * for the home is 收工), not a tab. Every other route keeps the layer
 * MOUNTED, so drafts and attachments cross `/app` ↔ `/settings` navigation;
 * off the app surface the panel is folded to its pill (below) — a fullscreen
 * conversation must not cover a page that has no world behind it.
 */
import { useLayoutEffect } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "@/i18n/navigation";
import type { UserConfig } from "@/lib/config/types";
import { useShell } from "@/components/shell/shell-provider";

const ConversationOverlay = dynamic(
  () =>
    import("./conversation-overlay").then((m) => m.ConversationOverlay),
  { ssr: false, loading: () => null },
);

export function ConversationOverlayMount({
  initialConfig,
}: {
  initialConfig?: UserConfig;
}) {
  const pathname = usePathname();
  const { panelMode, setPanelMode } = useShell();
  const gated = pathname === "/" || pathname.startsWith("/playground");
  const onApp = pathname === "/app";

  // Leaving the app surface folds the conversation to its pill: the layer
  // survives on utility routes (the draft rides along), but fullscreen is
  // the APP's conversation face. A layout effect, so the fold lands before
  // paint — a passive effect would flash the fullscreen body (and its
  // portal target) over the settings page for one frame. Gated routes are
  // excluded deliberately: the home must NOT touch the tier, so that
  // 继续 → `/app` still opens the app the way a fresh visit always has
  // (the fullscreen conversation at the conversation rung).
  useLayoutEffect(() => {
    if (!gated && !onApp && panelMode !== "pill") setPanelMode("pill");
  }, [gated, onApp, panelMode, setPanelMode]);

  if (gated) return null;
  return <ConversationOverlay initialConfig={initialConfig} />;
}
