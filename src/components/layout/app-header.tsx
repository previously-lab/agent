"use client";

/**
 * Floating-island chrome (v0.12, re-materialled v0.29) — the app is one
 * infinite canvas with no page boundaries, so the header is no longer a
 * full-width bar. Three detached controls hover over the canvas instead:
 *
 *   LEFT   the brand INSCRIPTION ("Previously on {name}") typed on the
 *          desk's top-left edge — no pill around it, still a link home —
 *          plus the status badges (status, not actions)
 *   MIDDLE the BOARD BAR — the rung dateline. It is rendered by the SHELL
 *          (`shell/board-bar.tsx`), not from here: the strand selection is
 *          shell state, which a layout has no access to.
 *   RIGHT  TWO square tool buttons and nothing else: the search palette
 *          and the "···" overflow, which carries settings and docs as well
 *          (see `nav-overflow-menu.tsx`). Two icons was a toolbar; two is a
 *          corner. The island CONTAINER is gone (v0.29 §4.2) — the buttons
 *          are bare instrument squares.
 *
 * The <header> element itself is pointer-transparent; each control
 * re-enables pointer events, so canvas content underneath the gaps stays
 * interactive.
 *
 * On the HOME route everything renders nothing at all: the reader has not
 * entered the app, the home says who this is in type, and its own action
 * row carries 设置. Search's Cmd/Ctrl+K shortcut is disabled there too (the
 * palette's `disabled` prop) — hidden, not just unbuttoned.
 */
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useBriefingIdentity } from "@/hooks/use-briefing-identity";
import { DemoBadge } from "@/components/layout/demo-badge";
import { ClientBadge } from "@/components/layout/client-badge";
import { SearchPalette } from "@/components/layout/search-palette";
import { NavOverflowMenu } from "@/components/layout/nav-overflow-menu";
import { ISLAND } from "@/components/layout/island";

export function AppHeader({ isDemo = false }: { isDemo?: boolean }) {
  const t = useTranslations("nav");
  const identity = useBriefingIdentity();
  // THE HOME IS NOT THE APP. The reader has not entered yet — the home says
  // who this is in type, at full size — so the brand intertitle stays out of
  // the way, and search is disabled with it (button AND the Cmd/Ctrl+K
  // shortcut; the route decision lives here, the shortcut's in the palette).
  const isHome = usePathname() === "/";

  return (
    // THE PHONE ARRANGEMENT IS THE READER'S, and it is a wrap rather than a
    // breakpoint dance. At phone width the header holds ONE line — the brand at
    // its start, the settings at its end — and the BOARD BAR (which the shell
    // renders, because the strand selection is shell state) takes the line
    // BELOW both, at the same right edge. From `md` up all three share one
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
      className="pointer-events-none fixed inset-x-0 top-0 z-40 flex flex-wrap items-center justify-between gap-2 p-2 sm:flex-nowrap md:p-4"
    >
      {/* LEFT — the brand intertitle + status badges (status, not actions).
          Hidden on the home: the home itself is the intertitle. */}

      {!isHome && (
      <div className="pointer-events-auto flex h-9 min-w-0 items-center gap-1.5">
        {/* "PREVIOUSLY ON {name}" — the same phrase the briefing card and the
            travel clock wear, sitting at the desk's top-left as every other
            control does: a square `ISLAND` in the DEFAULT SANS (the owner's
            ruling on first look — the mono inscription read wrong on the
            brand, and mono belongs to the paper's stamps, not to the app's own
            sentence). The WEIGHT SPLIT is still the whole reason it works at a
            glance: the lead is regular, the name is semibold and foreground,
            so the eye lands on WHO before it reads what is said about them.

            `You` IS THE ANSWER IN TWO CASES, deliberately: while the identity
            is in flight, and when the profile has no name at all (the server
            falls back to the same word — see `getUserName`). One word covers
            both because the reader's next move is identical either way, and a
            placeholder that later becomes a name is less jarring than a
            placeholder that becomes "unnamed". */}
        <Link
          href="/"
          className={`${ISLAND} inline-flex h-9 max-w-full min-w-0 items-center truncate px-3 text-sm transition-colors`}
        >
          {t("brand")}
          <span className="ms-1 font-semibold">
            {identity?.name || t("brandYou")}
          </span>
        </Link>
        {isDemo && <DemoBadge />}
        <ClientBadge />
      </div>
      )}

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
          list a reader READS rather than a row of controls they aim at.

          Hidden on the home with everything else: with the brand island gone,
          `justify-between` stranded this island at the LEFT edge — and a lone
          "···" on the start screen reads as an accident. The home has its own
          设置 door in the actions row; nothing here is needed before entering. */}
      {!isHome && (
        <nav className="pointer-events-auto ml-auto flex h-9 items-center gap-2 sm:ml-0">
          <SearchPalette disabled={isHome} />
          <NavOverflowMenu />
        </nav>
      )}
    </header>
  );
}
