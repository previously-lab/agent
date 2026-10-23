"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import "./writing.css";

/** One voice in a shared manuscript. History and live replies use the same
 * reading column; metadata never changes the width of the actual prose. */
export function ConversationTurn({
  role,
  metadata,
  children,
}: {
  role: string;
  metadata?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("desk");
  const speaker = t(role === "user" ? "recordUser" : "recordAgent");

  return (
    <article
      className="conversation-turn"
      data-conversation-turn
      data-role={role}
      data-slot="message"
      aria-label={speaker}
    >
      <header className="conversation-byline">
        <span className="conversation-speaker">{speaker}</span>
        {metadata && <span className="conversation-metadata">{metadata}</span>}
      </header>
      <div className="conversation-turn-content" data-slot="message-content">
        {children}
      </div>
    </article>
  );
}
