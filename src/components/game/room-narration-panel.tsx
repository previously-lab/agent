"use client";

/**
 * RoomNarrationPanel — Previously's voice inside a hotel room (v0.11 streams:
 * the mouth, §5, in the game).
 *
 * A compact DOM overlay (bottom-left, the corner the title overlay and the
 * door HUD leave free) that appears when a room mounts and streams the
 * companion endpoint's retrospective about that slice. The canvas is never
 * touched and never blocked: everything here is async fetch + React state.
 *
 * SESSION MEMORY. Requests go through a module-lifetime NarrationSession
 * (lib/companion/narration-store.ts): one request per slice per session.
 * Re-entering a room replays the entry that is already there — live if the
 * stream is still running (leaving the room does not cut it), complete if
 * it finished. Only an explicit retry re-asks, and only after a failure.
 *
 * FAILURE. A failed narration says so plainly in the panel (the companion
 * namespace's gentle error copy) and offers a retry — never a silent empty
 * box. The endpoint's budget gate (429) and bridge-mode 501 get their own
 * localized lines, same mapping as the companion pod.
 *
 * REPLY. A minimal input sends the user's words through the existing chat
 * path (POST /api/chat, lib/companion/room-reply.ts) so the reply becomes a
 * memory; the panel reports "kept" or "didn't go through" and nothing more —
 * the conversation itself still lives in the chat view.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { NarrateErrorCode } from "@/lib/companion/narrate";
import {
  createNarrationSession,
  type NarrationEntry,
  type NarrationSession,
} from "@/lib/companion/narration-store";
import { sendRoomReply } from "@/lib/companion/room-reply";

/**
 * One session per browser session (module lifetime): crossing the hotel is
 * what replays narrations, not re-requesting them. Survives leaving and
 * returning to /game within the SPA — that is the intended "this session".
 */
let sharedSession: NarrationSession | null = null;
function narrationSession(): NarrationSession {
  if (!sharedSession) sharedSession = createNarrationSession();
  return sharedSession;
}

type CompanionT = ReturnType<typeof useTranslations>;

/** The pod's mapping, kept: budget and bridge-mode get their own lines. */
function errorMessage(code: NarrateErrorCode, t: CompanionT): string {
  switch (code) {
    case "budget_exhausted":
      return t("errorBudget");
    case "unavailable":
      return t("errorUnavailable");
    default:
      return t("errorGeneric");
  }
}

function browserTimezone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

type ReplyState = "idle" | "sending" | "sent" | "failed";

export function RoomNarrationPanel({
  sliceId,
  label,
}: {
  /** The mounted room's slice — null in the corridor hides the panel. */
  sliceId: string | null;
  /** The door's label ("Sep 15 · 07:46"), for the panel header. */
  label?: string;
}) {
  const tGame = useTranslations("game");
  const tCompanion = useTranslations("companion");
  const locale = useLocale();
  const [entry, setEntry] = useState<NarrationEntry | null>(null);
  const [reply, setReply] = useState("");
  const [replyState, setReplyState] = useState<ReplyState>("idle");

  // Ask once per slice per session, then follow the entry: a stream already
  // in flight for this slice (left the room mid-sentence, came back) keeps
  // rendering live through the subscription.
  useEffect(() => {
    if (!sliceId) {
      setEntry(null);
      return;
    }
    const session = narrationSession();
    const timezone = browserTimezone();
    session.request(sliceId, {
      locale,
      ...(timezone ? { timezone } : {}),
    });
    setEntry(session.get(sliceId) ?? null);
    return session.subscribe(sliceId, setEntry);
  }, [sliceId, locale]);

  if (!sliceId) return null;

  const retry = () => {
    const timezone = browserTimezone();
    narrationSession().request(sliceId, {
      locale,
      ...(timezone ? { timezone } : {}),
      force: true,
    });
  };

  const submitReply = async (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text || replyState === "sending") return;
    setReplyState("sending");
    try {
      const timezone = browserTimezone();
      await sendRoomReply({
        text,
        locale,
        ...(timezone ? { timezone } : {}),
      });
      setReply("");
      setReplyState("sent");
    } catch {
      // The words stay in the input — nothing is lost, the user can resend.
      setReplyState("failed");
    }
  };

  const speaking = entry?.status === "pending";

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 sm:bottom-6 sm:left-6">
      <div
        data-room-narration
        className="pointer-events-auto w-[min(20rem,calc(100vw-3rem))] rounded-2xl bg-black/35 px-4 py-3 backdrop-blur-sm"
      >
        {label && (
          <p className="font-mono text-[10px] tabular-nums tracking-[0.08em] text-neutral-400">
            {label}
          </p>
        )}

        {/* The narration body — the pod's three states, pared down. */}
        {entry?.status === "failed" ? (
          <div className="mt-1.5">
            {entry.text && (
              <p className="whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-neutral-200">
                {entry.text}
              </p>
            )}
            <p
              className={`font-serif text-[13px] font-light leading-relaxed text-neutral-400 ${
                entry.text ? "mt-1.5" : ""
              }`}
            >
              {errorMessage(entry.error ?? "request_failed", tCompanion)}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 text-xs text-neutral-400 underline-offset-4 transition-colors hover:text-neutral-200 hover:underline"
            >
              {tCompanion("retry")}
            </button>
          </div>
        ) : entry && entry.text ? (
          <p
            aria-live="polite"
            className="mt-1.5 whitespace-pre-wrap font-serif text-[13px] font-light leading-relaxed text-neutral-200"
          >
            {entry.text}
            {speaking && (
              <span aria-hidden className="animate-pulse text-neutral-400">
                ▍
              </span>
            )}
          </p>
        ) : (
          <p className="mt-1.5 font-serif text-[13px] font-light italic leading-relaxed text-neutral-400">
            {tCompanion("thinking")}
          </p>
        )}

        {/* Reply — through the existing chat turn, so the words become a
            memory. Sending/sent/failed are one quiet line each. */}
        <form
          onSubmit={submitReply}
          className="mt-2 border-t border-white/10 pt-2"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={reply}
              onChange={(event) => {
                setReply(event.target.value);
                if (replyState !== "sending") setReplyState("idle");
              }}
              placeholder={tGame("replyPlaceholder")}
              aria-label={tGame("replyPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-xs text-neutral-200 outline-none placeholder:text-neutral-500"
            />
            <button
              type="submit"
              disabled={replyState === "sending" || reply.trim() === ""}
              className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-neutral-200 disabled:cursor-default disabled:opacity-40 disabled:hover:text-neutral-400"
            >
              {tGame("replySend")}
            </button>
          </div>
          {replyState === "sending" && (
            <p className="mt-1 text-[11px] text-neutral-500">
              {tGame("replySending")}
            </p>
          )}
          {replyState === "sent" && (
            <p className="mt-1 text-[11px] text-neutral-500">
              {tGame("replySent")}
            </p>
          )}
          {replyState === "failed" && (
            <p className="mt-1 text-[11px] text-neutral-400">
              {tGame("replyFailed")}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
