"use client";

import { useRef, useEffect, useCallback } from "react";

export function useScrollToBottom(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const shouldAutoScroll = useRef(true);

  const scrollToBottom = useCallback((force = false) => {
    const el = containerRef.current;
    if (!el) return;
    if (force || shouldAutoScroll.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distanceFromBottom > 100;
      shouldAutoScroll.current = !userScrolledUp.current;
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when deps change (new messages)
  useEffect(() => {
    scrollToBottom();
  }, deps);

  // Resume auto-scroll on new user message
  const onNewUserMessage = useCallback(() => {
    shouldAutoScroll.current = true;
    userScrolledUp.current = false;
    scrollToBottom(true);
  }, [scrollToBottom]);

  return { containerRef, scrollToBottom, onNewUserMessage };
}
