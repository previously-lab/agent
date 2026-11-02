"use client";

import { useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { conversationViewportInsets } from "@/lib/chat/visual-viewport";
import "./conversation-controls.css";

function subscribe(listener: () => void) {
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(listener); };
  window.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
  };
}
function snapshot() {
  const viewport = window.visualViewport;
  return [window.innerWidth, window.innerHeight, viewport?.width ?? window.innerWidth,
    viewport?.height ?? window.innerHeight, viewport?.offsetLeft ?? 0, viewport?.offsetTop ?? 0].join(",");
}

/** A body-level fixed seat cannot inherit the composer's filter/transform
 * containing block. Only its measured viewport offsets change with a keyboard;
 * uploads, draft height, disclosures and streaming never move this seat. */
export function ConversationControls({ children, inline = false, exposed = false, rootRef }: {
  children: ReactNode;
  inline?: boolean;
  exposed?: boolean;
  rootRef?: Ref<HTMLDivElement>;
}) {
  const viewport = useSyncExternalStore(subscribe, snapshot, () => "");
  const [width, height, visibleWidth, visibleHeight, offsetLeft, offsetTop] = viewport.split(",").map(Number);
  const insets = viewport ? conversationViewportInsets(width, height, { width: visibleWidth, height: visibleHeight, offsetLeft, offsetTop }) : { right: 0, bottom: 0, height: 0 };
  const content = <div ref={rootRef} data-conversation-controls data-controls-form={inline ? "inline" : "viewport"}
    data-controls-exposed={exposed || undefined} className="conversation-controls-seat"
    style={{ "--conversation-viewport-right": `${insets.right}px`, "--conversation-viewport-bottom": `${insets.bottom}px`,
      ...(insets.height ? { "--conversation-viewport-height": `${insets.height}px` } : {}) } as CSSProperties}>
    {children}
  </div>;
  return !inline && viewport ? createPortal(content, document.body) : content;
}

/** Same geometry while authoritative history is loading or unavailable. */
export function ConversationPrimaryPlaceholder({ inline = false }: { inline?: boolean }) {
  const t = useTranslations("chat.input");
  return <ConversationControls inline={inline}>
    <button type="button" data-conversation-primary data-primary-action="send" data-primary-placeholder
      className="conversation-primary-action" disabled aria-label={t("sendTooltip")}>
      <ArrowUp aria-hidden className="size-5" />
    </button>
  </ConversationControls>;
}
