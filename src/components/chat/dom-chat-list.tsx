"use client";

import { RichViewEnabled } from "./rich-content-view";

/**
 * DomChatList renders every loaded stream item in normal document flow.
 * Navigation, time reporting and the band feed use the committed browser
 * geometry; there is no estimated layout or mounted window.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations } from "next-intl";
import { DialogueUtterance } from "./dialogue-utterance";
import type { DialogueUtteranceSeat } from "./dialogue-stream-rows";
import { ChatMessage } from "./chat-message";
import { NestedBubble } from "./nested-bubble";
import { ParallelLaneView } from "./parallel-lane";
import { HistoryTurn } from "./history-turn";
import { SliceSeam } from "./slice-seam";
import { ResumeBanner } from "./resume-banner";
import { ErrorBanner } from "./error-banner";
import { EmptyBriefing } from "./empty-briefing";
import { StreamTimeIndicator } from "./stream-time-indicator";
import { Button } from "@/components/ui/button";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import { sliceIdOf } from "@/lib/chat/field-blocks";
import {
  clearFeed,
  offsetFor,
  progressFor,
  type FieldFeed,
} from "@/lib/timeline3d/field-feed";
import type { FieldAnchor } from "@/lib/timeline3d/winding";

const BOTTOM_SLOP_PX = 8;
const INDICATOR_HOLD_MS = 1000;
const TAIL_PAD_PX = 24;

export interface ChatStreamHandle {
  scrollToKey(key: string): boolean;
  scrollToOffset(px: number): void;
  offset(): number;
  scrollToBottom(): void;
}

export interface DomChatListProps {
  items: ChatStreamItem[];
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  error: Error | undefined;
  briefing?: React.ComponentProps<typeof EmptyBriefing> | null;
  feed?: FieldFeed;
  publishing?: boolean;
  apiRef?: MutableRefObject<ChatStreamHandle | null>;
  insetTop?: number;
  insetBottom?: number;
  composer?: ReactNode;
  emptyState?: ReactNode;
  contentInert?: boolean;
  floatingComposer?: boolean;
  dialogueUtterances?: ReadonlyMap<string, DialogueUtteranceSeat>;
  dialogueRegenerate?: (inputId: string) => void;
  newPublications?: number;
  /** Complete work/caption content for a dialogue-work placeholder item. */
  renderDialogueWork?: (item: ChatStreamItem) => ReactNode;
}

export function DomChatList({
  items,
  onTopItemChange,
  error,
  briefing,
  feed,
  publishing = false,
  apiRef,
  insetTop = 0,
  insetBottom = 0,
  composer,
  emptyState,
  contentInert = false,
  floatingComposer = false,
  dialogueUtterances,
  dialogueRegenerate,
  newPublications = 0,
  renderDialogueWork,
}: DomChatListProps) {
  const isMobile = useIsMobile();
  const tDialogue = useTranslations("chat.dialogue");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerTailRef = useRef<HTMLDivElement>(null);
  const [seenPublications, setSeenPublications] = useState(0);
  const publicationCount = useRef(newPublications);
  publicationCount.current = newPublications;
  const unread = Math.max(0, newPublications - seenPublications);
  const dialogueNotifications = dialogueUtterances !== undefined || newPublications > 0;
  const latestPublicationId = useMemo(
    () => [...(dialogueUtterances?.values() ?? [])].at(-1)?.publications.at(-1)?.utterance.utteranceId,
    [dialogueUtterances],
  );

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const insetTopRef = useRef(insetTop);
  insetTopRef.current = insetTop;
  const [following, setFollowing] = useState(true);
  const [anchoring, setAnchoring] = useState(true);
  const followingRef = useRef(true);
  const arrivingRef = useRef(true);
  const pendingKeyRef = useRef<string | null>(null);
  const onTopItemChangeRef = useRef(onTopItemChange);
  onTopItemChangeRef.current = onTopItemChange;
  const topKeyRef = useRef("");
  const [topTime, setTopTime] = useState<string | null>(null);
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const lastViewportHeightRef = useRef(0);
  const feedDirtyRef = useRef(true);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const disclosureScrollGuardRef = useRef(false);
  const nativeComposerInputRef = useRef(false);
  const nativeComposerInputFrameRef = useRef(0);

  const noteNativeComposerInput = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element) || !target.closest("[data-manuscript-composer]")) return;
    nativeComposerInputRef.current = true;
    if (nativeComposerInputFrameRef.current) cancelAnimationFrame(nativeComposerInputFrameRef.current);
    nativeComposerInputFrameRef.current = requestAnimationFrame(() => {
      nativeComposerInputRef.current = false;
      nativeComposerInputFrameRef.current = 0;
    });
  }, []);

  const releaseNativeComposerInput = useCallback(() => {
    nativeComposerInputRef.current = false;
    if (nativeComposerInputFrameRef.current) cancelAnimationFrame(nativeComposerInputFrameRef.current);
    nativeComposerInputFrameRef.current = 0;
  }, []);

  const updateFollowing = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    disclosureScrollGuardRef.current = false;
    setAnchoring(true);
    el.scrollTop = el.scrollHeight;
    programmaticScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    setSeenPublications(publicationCount.current);
  }, []);

  const releaseFollowForDisclosure = useCallback((target: EventTarget | null) => {
    const content = contentRef.current;
    if (!(target instanceof Element) || !content?.contains(target)) return;
    const disclosure = target.closest(
      "[data-dialogue-work-caption], summary, [aria-expanded]",
    );
    if (!disclosure || !content.contains(disclosure)) return;
    arrivingRef.current = false;
    updateFollowing(false);
    // Closing a disclosure can clamp scrollTop several frames later. Keep
    // following suspended until an actual outer-scroll gesture or explicit
    // jump: a browser layout adjustment is not reader intent.
    disclosureScrollGuardRef.current = true;
    setAnchoring(false);
  }, [updateFollowing]);

  const allowOuterScroll = useCallback((target: EventTarget | null) => {
    releaseNativeComposerInput();
    if (target instanceof Element && target.closest('[data-slot="scroll-area-viewport"]')) return;
    disclosureScrollGuardRef.current = false;
    setAnchoring(true);
  }, [releaseNativeComposerInput]);

  const reportTop = useCallback(() => {
    feedDirtyRef.current = true;
    const el = scrollerRef.current;
    const content = contentRef.current;
    const its = itemsRef.current;
    if (!el || !content || its.length === 0) return;
    const rows = Array.from(content.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && Boolean(child.dataset.key),
    );
    if (rows.length === 0) return;
    const topEdge = el.getBoundingClientRect().top + insetTopRef.current;
    let topRow = rows[0];
    for (const row of rows) {
      if (row.getBoundingClientRect().top > topEdge + 1) break;
      topRow = row;
    }
    const item = its.find((candidate) => candidate.key === topRow.dataset.key);
    if (!item || item.key === topKeyRef.current) return;
    topKeyRef.current = item.key;
    setTopTime(item.timeIso);
    onTopItemChangeRef.current?.(item.timeIso, sliceIdOf(item));
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Update the lease synchronously. A same-frame content commit must not
    // override a reader who has just started scrolling back up.
    const atBottom =
      el.scrollTop >= el.scrollHeight - el.clientHeight - BOTTOM_SLOP_PX;
    const wasProgrammatic = programmaticScrollTopRef.current === el.scrollTop;
    programmaticScrollTopRef.current = null;
    const wasDisclosure = disclosureScrollGuardRef.current;
    // Native caret scrolling is part of editing, not reader intent. Keep the
    // live-edge lease until ResizeObserver can account for the grown composer.
    const nativeComposerInput = nativeComposerInputRef.current;
    if (!wasProgrammatic && !wasDisclosure && !nativeComposerInput) {
      if (!atBottom) arrivingRef.current = false;
      updateFollowing(atBottom);
      if (atBottom) setSeenPublications(publicationCount.current);
    }
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      reportTop();
      setIndicatorVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(
        () => setIndicatorVisible(false),
        INDICATOR_HOLD_MS,
      );
    });
  }, [reportTop, updateFollowing]);

  useEffect(
    () => () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      if (nativeComposerInputFrameRef.current) cancelAnimationFrame(nativeComposerInputFrameRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // New items and streaming growth follow only while the reader remains at
  // the live edge. A navigation request or upward scroll releases this pin.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (arrivingRef.current || followingRef.current) pinToBottom();
    else lastScrollHeightRef.current = el.scrollHeight;
    reportTop();
  }, [items, insetBottom, pinToBottom, reportTop]);

  useLayoutEffect(() => {
    feedDirtyRef.current = true;
  }, [insetTop]);

  // Observe content, not estimated rows. Shrinking (for example collapsing
  // expanded thoughts) never triggers a programmatic move.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    lastScrollHeightRef.current = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = el.scrollHeight;
      const nextViewportHeight = el.clientHeight;
      const changed =
        nextHeight !== lastScrollHeightRef.current ||
        nextViewportHeight !== lastViewportHeightRef.current;
      const grew = nextHeight > lastScrollHeightRef.current;
      lastScrollHeightRef.current = nextHeight;
      lastViewportHeightRef.current = nextViewportHeight;
      if (changed) feedDirtyRef.current = true;
      if (!grew || (!arrivingRef.current && !followingRef.current)) return;
      pinToBottom();
    });
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    if (composerTailRef.current) observer.observe(composerTailRef.current);
    return () => observer.disconnect();
  }, [pinToBottom]);

  const findIndexFor = useCallback((key: string): number => {
    const its = itemsRef.current;
    const exact = its.findIndex((item) => item.key === key);
    if (exact >= 0) return exact;
    return its.findIndex((item) => item.key.endsWith(key));
  }, []);

  const scrollToIndex = useCallback((idx: number) => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    const key = itemsRef.current[idx]?.key;
    if (!el || !content || !key) return;
    const row = Array.from(content.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.key === key,
    );
    if (!row) return;
    el.scrollTop =
      el.scrollTop +
      row.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      insetTopRef.current;
    programmaticScrollTopRef.current = el.scrollTop;
    reportTop();
  }, [reportTop]);

  useEffect(() => {
    const key = pendingKeyRef.current;
    if (!key) return;
    const idx = findIndexFor(key);
    if (idx < 0) return;
    pendingKeyRef.current = null;
    arrivingRef.current = false;
    updateFollowing(false);
    scrollToIndex(idx);
  }, [items, findIndexFor, scrollToIndex, updateFollowing]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      scrollToKey(key) {
        arrivingRef.current = false;
        updateFollowing(false);
        const idx = findIndexFor(key);
        if (idx >= 0) {
          scrollToIndex(idx);
          return true;
        }
        pendingKeyRef.current = key;
        return false;
      },
      scrollToOffset(px) {
        arrivingRef.current = false;
        updateFollowing(false);
        const el = scrollerRef.current;
        if (el) {
          el.scrollTop = px;
          programmaticScrollTopRef.current = el.scrollTop;
        }
      },
      scrollToBottom() {
        arrivingRef.current = true;
        updateFollowing(true);
        pinToBottom();
      },
      offset() {
        return scrollerRef.current?.scrollTop ?? 0;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, findIndexFor, pinToBottom, scrollToIndex, updateFollowing]);

  // The band feed reads the same browser geometry as navigation and time.
  const seekGenRef = useRef(-1);
  useEffect(() => {
    if (!feed || !publishing) return;
    clearFeed(feed);
    feedDirtyRef.current = true;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = scrollerRef.current;
      const content = contentRef.current;
      if (!el || !content) return;
      const seek = feed.seek;
      const hasSeek = Boolean(seek && seek.gen !== seekGenRef.current);
      if (!hasSeek && !feedDirtyRef.current) return;
      feedDirtyRef.current = false;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (seek && hasSeek) {
        seekGenRef.current = seek.gen;
        arrivingRef.current = false;
        updateFollowing(false);
        el.scrollTop = offsetFor(seek.progress, 0, max);
        programmaticScrollTopRef.current = el.scrollTop;
      }
      const st = el.scrollTop;
      const vh = el.clientHeight || 1;
      feed.progress = progressFor(st, 0, max);
      feed.crossing.y = null;

      const rows = new Map<string, HTMLElement>();
      for (const child of Array.from(content.children)) {
        if (child instanceof HTMLElement && child.dataset.key) {
          rows.set(child.dataset.key, child);
        }
      }
      const its = itemsRef.current;
      const scrollerTop = el.getBoundingClientRect().top + insetTopRef.current;
      const contentBottom = content.getBoundingClientRect().bottom;
      const yFor = (row: HTMLElement) =>
        (row.getBoundingClientRect().top - scrollerTop) / vh;
      const list: FieldAnchor[] = [];
      for (let i = 0; i < its.length && list.length < 24; i++) {
        const item = its[i];
        if (item.kind !== "seam") continue;
        const row = rows.get(item.key);
        if (!row) continue;
        const startY = yFor(row);
        let endY = (contentBottom - scrollerTop) / vh;
        for (let j = i + 1; j < its.length; j++) {
          if (its[j].kind !== "seam") continue;
          const nextRow = rows.get(its[j].key);
          if (nextRow) endY = yFor(nextRow);
          break;
        }
        if (!(endY > startY)) continue;
        const y = (startY + endY) / 2;
        if (y < -1.5 || y > 2.5) continue;
        const sid = item.key.slice("seam-".length);
        list.push({
          y,
          strands: item.strands,
          span: endY - startY,
          date: /^\d{4}-\d{2}-\d{2}/.test(sid) ? sid.slice(0, 10) : undefined,
        });
      }
      const live = its.find((item) => item.kind === "live");
      const liveRow = live ? rows.get(live.key) : undefined;
      if (live?.kind === "live" && liveRow) {
        const liveStart = yFor(liveRow);
        const liveH = (contentBottom - liveRow.getBoundingClientRect().top) / vh;
        if (liveH > 0 && liveStart < 1 && liveStart + liveH > 0) {
          list.push({
            y: liveStart + liveH / 2,
            strands: live.strands ?? [],
            span: liveH,
            date: live.timeIso.slice(0, 10),
          });
        }
      }
      feed.anchors = list;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearFeed(feed);
    };
  }, [feed, publishing, updateFollowing]);

  const renderItem = (item: ChatStreamItem) => {
    switch (item.kind) {
      case "seam":
        return (
          <div className="conversation-stream-row">
            <SliceSeam
              seam={item.seam}
              dateIso={item.dateIso}
              prevActivityIso={item.prevActivityIso}
            />
          </div>
        );
      case "resume-banner":
        return <ResumeBanner startIso={item.startIso} />;
      case "briefing":
        return briefing ? <EmptyBriefing variant="card" {...briefing} /> : null;
      case "history-turn":
        return (
          <div className="conversation-stream-row">
            <HistoryTurn
              role={item.turn.role}
              content={item.turn.content}
              sliceId={item.sliceId}
              turnId={item.turn.turnId}
              timestamp={item.turn.timestamp}
              documentContext={item.turn.documentContext}
              attachments={item.turn.attachments}
              sourceRole={item.turn.sourceRole}
              dialogue={item.turn.dialogue}
              artifactBodies={item.turn.artifactBodies}
              continuations={item.continuations}
            />
          </div>
        );
      case "live": {
        if (item.key.startsWith("dialogue-work:")) {
          const work = renderDialogueWork?.(item);
          if (work !== null && work !== undefined && typeof work !== "boolean") {
            return work;
          }
        }
        const publication = dialogueUtterances?.get(item.key);
        const publicationInputId = publication?.publications[0]?.utterance.inputIds[0];
        const latestPublication = publication?.publications.at(-1)?.utterance;
        const inputId = item.key.startsWith("dialogue-input:")
          ? item.key.slice("dialogue-input:".length)
          : undefined;
        return (
          <div className="conversation-stream-row" data-dialogue-input={inputId}>
            {publication ? (
              <DialogueUtterance
                {...publication}
                onRegenerate={
                  latestPublication?.utteranceId === latestPublicationId &&
                  publicationInputId && publication.publications[0]?.utterance.inputIds.length === 1 &&
                  dialogueRegenerate
                    ? () => dialogueRegenerate(publicationInputId)
                    : undefined
                }
              />
            ) : (
              <ChatMessage
                message={item.message}
                isStreaming={item.isStreaming}
                startedAt={item.startedAt}
                onRegenerate={item.onRegenerate}
              />
            )}
          </div>
        );
      }
      case "nested-bubble":
        return (
          <div className="conversation-stream-row">
            <NestedBubble frame={item.frame} excerpt={item.excerpt} />
          </div>
        );
      case "parallel-lane":
        return (
          <div className="conversation-stream-row">
            <ParallelLaneView lane={item.lane} />
          </div>
        );
    }
  };

  return (
    <RichViewEnabled.Provider value>
    <div className={`conversation-stream-shell mx-auto flex h-full flex-col ${floatingComposer ? "" : "relative"}`}>
      <div
        ref={scrollerRef}
        data-conversation-field
        tabIndex={0}
        role="log"
        aria-live={dialogueNotifications ? "off" : undefined}
        onScroll={handleScroll}
        onBeforeInputCapture={event => noteNativeComposerInput(event.target)}
        onInputCapture={event => noteNativeComposerInput(event.target)}
        onWheelCapture={event => allowOuterScroll(event.target)}
        onTouchMoveCapture={event => allowOuterScroll(event.target)}
        onPointerDown={event => {
          if (event.target === event.currentTarget) allowOuterScroll(event.target);
        }}
        onClickCapture={(event) => releaseFollowForDisclosure(event.target)}
        onKeyDownCapture={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if ((event.key === "Enter" || event.key === " ") && target?.closest("[data-dialogue-work-caption], summary, [aria-expanded]")) {
            releaseFollowForDisclosure(event.target);
          } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
            !target?.closest('input, textarea, [contenteditable="true"]')) {
            allowOuterScroll(event.target);
          }
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain outline-none"
        style={{
          overflowAnchor: anchoring ? "auto" : "none",
          paddingTop: insetTop,
          paddingBottom: (composer ? 0 : insetBottom) + TAIL_PAD_PX,
        }}
      >
        <div ref={contentRef} className={composer && !floatingComposer ? "shrink-0" : "shrink-0 grow"} inert={contentInert || undefined}>
          {emptyState ? (
            emptyState
          ) : (
            <>
              {items.map((item) => (
                <div key={item.key} data-key={item.key}>
                  {renderItem(item)}
                </div>
              ))}
              {error && <ErrorBanner error={error} />}
            </>
          )}
        </div>
        {composer && (
          <div
            ref={composerTailRef}
            className="conversation-stream-row conversation-composer-tail shrink-0 [overflow-anchor:none]"
            data-composer-tail
          >
            {composer}
          </div>
        )}
      </div>

      {dialogueNotifications && !contentInert && (
        <>
          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-dialogue-announcement
          >
            {newPublications > 0 && (
              <span key={newPublications}>{tDialogue("replyArrived")}</span>
            )}
          </div>
          {unread > 0 && !following && (
            <Button
              type="button"
              variant="ghost"
              className="dialogue-new-replies"
              data-dialogue-new-replies
              onClick={() => {
                // Work seats can own the first reply, leaving the utterance
                // map empty. The button always has a bottom to scroll to.
                arrivingRef.current = true;
                updateFollowing(true);
                pinToBottom();
              }}
            >
              {tDialogue("newReplies", { count: unread })}
            </Button>
          )}
        </>
      )}

      {isMobile && (
        <div inert={contentInert || undefined}>
          <StreamTimeIndicator timeIso={topTime} visible={indicatorVisible} />
        </div>
      )}
    </div>
    </RichViewEnabled.Provider>
  );
}
