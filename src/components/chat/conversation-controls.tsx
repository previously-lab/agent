"use client";

import { type ReactNode, type Ref } from "react";
import { ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import "./conversation-controls.css";

/** Manuscript controls occupy the draft's own final layout row, so they scroll
 * with the editor and reserve their space. The collapsed pill keeps its inline
 * control row; neither form needs a viewport-fixed fallback. */
export function ConversationControls({ children, inline = false, exposed = false, rootRef }: {
  children: ReactNode;
  inline?: boolean;
  exposed?: boolean;
  rootRef?: Ref<HTMLDivElement>;
}) {
  return <div ref={rootRef} data-conversation-controls data-controls-form={inline ? "inline" : "editor"}
    data-controls-exposed={exposed || undefined} className="conversation-controls-seat">
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
