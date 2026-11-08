"use client";

import { type ReactNode, type Ref } from "react";
import { ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import "./conversation-controls.css";

/** Manuscript controls occupy the draft's own final layout row, spanning the
 * writing column as a compact toolbar: the tools cluster at the start, the
 * Send/Stop group flush at the end. The collapsed pill keeps its inline
 * control row; neither form needs a viewport-fixed fallback. */
export function ConversationControls({ children, inline = false, rootRef }: {
  children: ReactNode;
  inline?: boolean;
  rootRef?: Ref<HTMLDivElement>;
}) {
  return <div ref={rootRef} data-conversation-controls data-controls-form={inline ? "inline" : "editor"}
    className="conversation-controls-seat">
    {children}
  </div>;
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
