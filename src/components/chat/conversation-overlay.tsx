"use client";

/**
 * ConversationOverlay (v0.13 §3.1) — the conversation layer itself, mounted
 * ONCE at the layout as a sibling of the route content.
 *
 * WHAT MOVED AND WHY. This is the panel half of the old AppShell: the
 * two-tier `ConversationPanel` (pill / fullscreen, §4) with the one
 * always-mounted `ChatPage` inside it. It used to render INSIDE the route's
 * shell, which made the panel a prisoner of the route's lifetime — any
 * rebuild of the shell subtree remounted the panel, and the conversation
 * field's R3F band reached its seat through portal slots the shell owned.
 * Now the layer is hosted by `[locale]/layout.tsx` (through the gate in
 * `conversation-overlay-mount.tsx`), floats above the canvas by z-index, and
 * survives navigation and world rebuilds: the draft, the attachments and the
 * live `useChat` stream no longer depend on which route is mounted.
 *
 * EVERYTHING SHARED ARRIVES THROUGH `useShell()` (shell-provider.tsx): the
 * tier and its setter, the feed, the send-time view getter, the feed lease
 * and `?at=` suppression the route computes, the composer clearance this
 * subtree measures and the route's card field reads, and the two turn
 * callbacks — forwarded to the world's registered driver, no-ops on routes
 * with no world. The only state owned HERE is the pill's subtitle line: it
 * is produced by ChatPage and rendered by the panel, both inside this
 * component, so the wire between them never leaves it.
 *
 * THE PANEL-BODY SLOT stays: at fullscreen the panel is viewport-wide and
 * hosts the R3F field itself, so `bodyPrefix` is the portal target — now
 * registered with the PROVIDER (which composes the surface), not with a
 * route. The field's OTHER seat (the pane slot) is rendered by the app
 * route; see `app-shell.tsx`.
 */
import { useState } from "react";
import type { UserConfig } from "@/lib/config/types";
import type { SubtitleLine } from "@/lib/chat/subtitle-line";
import { useShell } from "@/components/shell/shell-provider";
import { ChatPage } from "./chat-page";
import { ConversationPanel } from "./conversation-panel";

export function ConversationOverlay({
  initialConfig,
}: {
  /** Server-preloaded user config (through the layout's async boundary) —
   *  seeds the selected model so the chat starts on the real value. */
  initialConfig?: UserConfig;
}) {
  const shell = useShell();
  // The pill's subtitle line (v0.13 §4): folded from the unified stream by
  // ChatPage, lifted HERE, and handed back down into the panel as a prop —
  // the panel renders it, the page produces it, and this state is the wire
  // between them.
  const [subtitleLine, setSubtitleLine] = useState<SubtitleLine | null>(null);

  return (
    <ConversationPanel
      mode={shell.panelMode}
      onModeChange={shell.setPanelMode}
      subtitleLine={subtitleLine}
      bodyPrefix={
        shell.panelMode === "fullscreen" ? (
          <div ref={shell.setPanelSlotEl} className="min-h-0 flex-1" />
        ) : undefined
      }
    >
      <ChatPage
        initialConfig={initialConfig}
        suppressAtJump={shell.suppressAtJump}
        rung="conversation"
        onTurnSettled={shell.reportTurnSettled}
        feed={shell.feed}
        // v0.13 §5 — the current view rides each turn's request so the model
        // knows what the reader is looking at (see the provider's getChatView).
        getView={shell.getChatView}
        // Frozen while a world transition runs: the feed is one-writer
        // (field-feed.ts), and a move mounts/unmounts the fields around the
        // band — nobody publishes mid-move. The route computes the lease.
        publishing={shell.publishing}
        onRunningChange={shell.reportRunning}
        onSubtitleLineChange={setSubtitleLine}
        insetTop={0}
        insetBottom={shell.composerClearance}
        onComposerClearanceChange={shell.setComposerClearance}
      />
    </ConversationPanel>
  );
}
