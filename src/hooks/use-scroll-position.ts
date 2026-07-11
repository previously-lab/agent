"use client";

import { useState, useEffect } from "react";

/**
 * Tracks window.scrollY with a passive listener. Returns the current scroll
 * position and a boolean `scrolled` that flips when the user has scrolled
 * past `threshold` pixels (default ~70% of a typical viewport, enough to
 * clear the hero section).
 */
export function useScrollPosition(threshold = 560) {
  const [scrollY, setScrollY] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setScrollY(window.scrollY);

    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return { scrollY, scrolled: scrollY > threshold, mounted };
}
