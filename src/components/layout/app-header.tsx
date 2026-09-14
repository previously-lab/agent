"use client";

/**
 * Floating-island chrome (v0.12) — the app is one infinite canvas with no
 * page boundaries, so the header is no longer a full-width bar. Three
 * detached pills hover over the canvas instead:
 *
 *   LEFT   the brand INTER TITLE ("Previously on {name}") + status badges
 *   MIDDLE the BOARD BAR — the zoom lens and the strand selector. It is
 *          rendered by the SHELL (`shell/board-bar.tsx`), not from here: the
 *          strand selection is shell state, which a layout has no access to.
 *   RIGHT  TWO controls and nothing else: the search palette and the "···"
 *          overflow, which now carries settings and docs as well (see
 *          `nav-overflow-menu.tsx`). Four icons was a toolbar; two is a
 *          corner.
 *
 * The <header> element itself is pointer-transparent; each island re-enables
 * pointer events, so canvas content underneath the gaps stays interactive
 * and scrolls beneath the frosted pills.
 */
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useBriefingIdentity } from "@/hooks/use-briefing-identity";
import { DemoBadge } from "@/components/layout/demo-badge";
import { ClientBadge } from "@/components/layout/client-badge";
import { SearchPalette } from "@/components/layout/search-palette";
import { NavOverflowMenu } from "@/components/layout/nav-overflow-menu";
import { ISLAND_BAR } from "./island";

export function AppHeader({ isDemo = false }: { isDemo?: boolean }) {
  const t = useTranslations("nav");
  const identity = useBriefingIdentity();

  return (
    // THE PHONE ARRANGEMENT IS THE READER'S, and it is a wrap rather than a
    // breakpoint dance. At phone width the header holds ONE line — the brand at
    // its start, the settings at its end — and the BOARD BAR (which the shell
    // renders, because the strand selection is shell state) takes the line
    // BELOW both, at the same right edge. From `sm` up all three share one
    // line, `justify-between` puts the brand at the start and the settings at
    // the end, and the board bar floats centered between them.
    //
    // THE PAIRING IS THE WHOLE POINT OF THE SWAP. The brand used to share the
    // first line with the board bar, and that stopped fitting the moment the
    // brand became an intertitle: "Previously on {name}" measures ~197 px
    // against the wordmark's 84, and the board bar is 244 — 465 px of islands
    // on a 390 px line, overlapping by 67. The settings island is 66, so
    // pairing the brand with THAT fits with room to spare (287 of 390).
    //
    // It also reads the right way round: the first line is now the app's —
    // who this is, and where you configure it — and the second is the field's,
    // sitting directly on top of the content it controls.
    // `data-app-header` is the stable hook the chrome's height is measured
    // through — see `use-chrome-inset.ts`, which reads this element and the
    // board bar (a SHELL child, so no single owner holds both) to learn how
    // far down the pane the floating chrome actually reaches.
    <header
      data-app-header
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex flex-wrap items-center justify-between gap-2 p-2 sm:flex-nowrap sm:p-3 md:p-4"
    >
      {/* LEFT — the brand intertitle + status badges (status, not actions).
          EVEN PADDING, and the badges correct it themselves. This used to be
          `pr-1.5 pl-3`, which compensated for a pill's own filled edge — and
          was wrong the moment no badge rendered, leaving the wordmark 6px from
          one edge and 12 from the other. See `ISLAND_BADGE`.

          IT DOES NOT ANIMATE ITS WIDTH, deliberately. A width transition needs
          a NUMBER — CSS cannot interpolate a shrink-to-fit box — and buying
          one means measuring the content in a second element and pinning the
          pill to the result, which is a lot of machinery around a piece of
          chrome for one moment on load, when the name arrives. The island just
          grows. */}
      <div className={`pointer-events-auto ${ISLAND_BAR} gap-1.5 px-3`}>
        {/* "PREVIOUSLY ON {name}" — the same phrase the briefing card and the
            travel clock wear, moved into the chrome. It is the product's own
            sentence rather than a wordmark, and the WEIGHT SPLIT is the whole
            reason it works at a glance: the lead is muted and regular, the
            name is semibold and foreground, so the eye lands on WHO before it
            reads what is being said about them.

            `You` IS THE ANSWER IN TWO CASES, deliberately: while the identity
            is in flight, and when the profile has no name at all (the server
            falls back to the same word — see `getUserName`). One word covers
            both because the reader's next move is identical either way, and a
            placeholder that later becomes a name is less jarring than a
            placeholder that becomes "unnamed". */}
        <Link
          href="/"
          className="min-w-0 truncate text-sm font-normal tracking-tight text-muted-foreground transition-colors hover:text-foreground/80"
        >
          {t("brand")}{" "}
          <span className="font-semibold text-foreground">
            {identity?.name || t("brandYou")}
          </span>
        </Link>
        {isDemo && <DemoBadge />}
        <ClientBadge />
      </div>

      {/* CENTER — the board bar (zoom lens + strand selector), which the SHELL
          renders (`shell/board-bar.tsx`). It cannot live here: the strand
          selection is shell state, and the layout's header has no access to
          it. `top-14` under `sm`, `top-3`/`top-4` above — see that file. The
          「对话 · 时间线」 pill that used to sit here is gone: it was the
          coarse half of the same axis the lens already offered. */}

      {/* RIGHT — TWO CONTROLS, and a corner is the right shape for it. This
          carried four glyphs (search, settings, docs, "···"), which is a
          toolbar: four things aimed at on every screen, when exactly one of
          them — search — is something a reader reaches for mid-thought. The
          other three are configuration, and configuration belongs behind the
          button that says "the rest". Settings and docs are menu rows now (see
          `nav-overflow-menu.tsx`); they gained their labels on the way, which
          the icon row could never afford.

          The "···" keeps its own labels for the reason it always had: it is a
          list a reader READS rather than a row of controls they aim at. */}
      <nav className={`pointer-events-auto ${ISLAND_BAR} ml-auto gap-0.5 p-1 sm:ml-0`}>
        <SearchPalette />
        <NavOverflowMenu />
      </nav>
    </header>
  );
}
