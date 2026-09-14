"use client";

import { useLayoutEffect, useState } from "react";

/**
 * How far down the pane the floating TOP chrome reaches, in px.
 *
 * THE CHROME OWNS NO SPACE, so something has to measure it. It is `fixed` —
 * out of flow, painting over the pane — which is the whole point of the
 * island look and also the reason nothing is pushed out of its way. What the
 * content needs is therefore not a layout property but a MEASUREMENT of
 * something that lives outside the content's own tree.
 *
 * It is measured rather than declared because every candidate constant was
 * wrong in a different place. The chrome is one row from `sm` up and TWO rows
 * at phone width (the settings island wraps under the board bar); it grows a
 * hint bubble on a first visit and loses it on the first rung change; and the
 * brand island grows a badge in demo and client modes. Three constants went
 * wrong three ways — the two-row one was exactly flush with the reserve at
 * 390 px (zero slack, so any addition overlapped), and the one-row ones left
 * the hint bubble sitting on the content at every width from 640 up.
 *
 * WHAT IS MEASURED IS THE PAINTED BOTTOM, not the header's own box: the union
 * of every element in the two chrome subtrees. The header element's box
 * includes its own padding, which paints nothing — and including it is the
 * right call anyway, because a reserve that lands exactly on the last pixel of
 * `backdrop-blur` is a reserve with no breathing room.
 *
 * The two roots are queried rather than passed in because the header is
 * rendered by the LAYOUT and the board bar by the SHELL, so no single owner
 * holds both. Anything that floats at the pane's top edge belongs in one of
 * them; a popover or a menu is PORTALLED out of both (`ui/popover.tsx`,
 * `ui/dropdown-menu.tsx`), so opening one cannot inflate the reserve.
 *
 * Consulted in a layout effect, like `use-tier.ts` and `use-is-mobile.ts`: the
 * server and the first client render both carry 0 so hydration matches, and
 * the measured value lands BEFORE the first paint.
 */
const CHROME_ROOTS = ["[data-app-header]", "[data-board-bar]"] as const;

/** The union's painted bottom, in px. Zero when neither root is mounted (the
 *  settings route renders no board bar) — which reads correctly as "no chrome
 *  to clear", not as a failed measurement. */
function measure(): number {
  let bottom = 0;
  for (const selector of CHROME_ROOTS) {
    const root = document.querySelector(selector);
    if (!root) continue;
    const box = root.getBoundingClientRect();
    // A root with no box at all (the phone spacer, a display:contents wrapper)
    // contributes nothing and must not drag the union to its own zero.
    if (box.width !== 0 || box.height !== 0) {
      if (box.bottom > bottom) bottom = box.bottom;
    }
    for (const el of root.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom > bottom) bottom = r.bottom;
    }
  }
  return Math.ceil(bottom);
}

export function useChromeInset(): number {
  const [inset, setInset] = useState(0);

  useLayoutEffect(() => {
    setInset(measure());

    // Two triggers, because the chrome changes shape in two unrelated ways.
    //
    // A RESIZE re-wraps the header — one row becomes two at the phone
    // breakpoint — and moves the islands' own boxes, so it is caught by a
    // ResizeObserver on the roots. A hint bubble MOUNTING does not: it is
    // `absolute`, so it changes no ancestor's box, which is exactly why a
    // ResizeObserver alone silently missed it and the reserve stayed short.
    // Neither observer can loop: the inset moves the camera and a reserved
    // padding, and no chrome root reads either one.
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setInset(measure()));
    };

    const ro = new ResizeObserver(remeasure);
    const mo = new MutationObserver(remeasure);
    const roots: Element[] = [];
    for (const selector of CHROME_ROOTS) {
      const root = document.querySelector(selector);
      if (!root) continue;
      roots.push(root);
      ro.observe(root);
      mo.observe(root, { childList: true, subtree: true });
    }

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      roots.length = 0;
    };
  }, []);

  return inset;
}
