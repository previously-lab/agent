import { ChatStreamSkeleton } from "@/components/chat/chat-skeleton";

/**
 * The instant placeholder for every route under the locale segment.
 *
 * Without it the browser sits on the previous page (or a blank document) until
 * the server has produced the page segment — and on the home route that
 * segment does real work (a config read, and behind it the shell's own mount
 * fetches). Next only shows a fallback at all if this file exists; a
 * `<Suspense>` inside the page covers the awaits that happen AFTER the segment
 * starts streaming, not the one before its first byte.
 *
 * The layout — the header — is outside this file and renders immediately, so
 * what the reader sees is the app chrome plus the conversation's own loading
 * face, which is the same skeleton the page swaps in a moment later. Same
 * component, so the handover is invisible.
 */
export default function Loading() {
  return <ChatStreamSkeleton />;
}
