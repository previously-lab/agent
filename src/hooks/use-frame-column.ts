"use client";

/**
 * The chat column width that TRACKS the timeline card field (v0.11 shell).
 * The timeline's CardField sizes its card column with `frameGeometryFor`
 * (78% of the field, capped at 900px on desktop, fixed gutters when narrow);
 * the chat page measures the SAME pane box through this hook and derives the
 * identical width, so switching between the chat and timeline views keeps
 * the content's left/right edges on the card column's edges — no jump.
 *
 * The observed element is the ref's PARENT: ChatPage's stream area mounts
 * inside the shell's right-hand column, whose box is exactly what the
 * timeline scene measures its own field from (`absolute inset-0`).
 */
import { useEffect, useRef, useState } from "react";
import { frameGeometryFor } from "@/lib/timeline3d/stacks";

export function useFrameColumn() {
  const ref = useRef<HTMLDivElement | null>(null);
  /** px width of the card column for the current pane size; null before the
   *  first measurement (callers fall back to their legacy responsive class). */
  const [columnWidth, setColumnWidth] = useState<number | null>(null);

  useEffect(() => {
    const pane = ref.current?.parentElement;
    if (!pane) return;
    const update = () => {
      const w = pane.clientWidth;
      const h = pane.clientHeight;
      setColumnWidth(w > 0 && h > 0 ? frameGeometryFor(w, h).cardW : null);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  return { ref, columnWidth };
}
