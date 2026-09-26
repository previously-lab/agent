/**
 * The frosted-island shell — the app's ONE chrome surface.
 *
 * The app is an infinite canvas with no page boundaries, so every piece of
 * chrome floats over it in the same material: a translucent background, a
 * hairline ring, a blur behind, and one soft shadow. That is the whole look,
 * and it was previously typed out four times (the header's two islands, the
 * lens switcher, the board bar, the composer's compact pill) with four chances
 * to drift a shade or a blur radius apart.
 *
 * It is a STRING and not a component on purpose. The islands are not the same
 * element — a `<header>` child, a `<nav>`, a `role="group"` div, a `<button>`'s
 * container — and wrapping them in a shared component would mean either
 * polymorphic `as` machinery or a wrapper div inside each one, which is a box
 * the layout did not ask for. What they share is the finish, so the finish is
 * what is shared.
 *
 * Change a value here and every island in the app moves at once. That is the
 * point.
 */
export const ISLAND =
  "rounded-full bg-background/75 ring-1 ring-border/60 backdrop-blur-md shadow-md";

/**
 * A control INSIDE an island. Round, quiet at rest, foreground on hover — the
 * same four states whether it is a link, a button or a popover trigger.
 *
 * Split from `ISLAND` because the two are answering different questions: the
 * island is the surface, this is what sits on it. A control that borrowed the
 * island's own classes would put a second blurred panel inside the first.
 */
export const ISLAND_CONTROL =
  "flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

/**
 * A BAR — an island that holds controls, at the one height all three of the
 * top bars share.
 *
 * They were the same material and different SHAPES: the brand island sized
 * itself to its own text (28px), the settings island to its controls (36px),
 * and the board bar to a mix — three pills of three heights sitting on one
 * line. `h-9` is fixed here rather than derived so the three cannot drift
 * apart again when one of them gains a control, and every control inside is
 * `size-7`, which leaves the bars a uniform 4px of padding.
 *
 * A bar sets its own `gap` and its own horizontal padding; only the height and
 * the alignment are shared.
 */
export const ISLAND_BAR = `${ISLAND} flex h-9 items-center`;

/*
 * The status PILL at the end of an island bar — a badge that carries its own
 * filled shape, its own internal padding, and `-mr-1.5` at its first class
 * position in each badge file.
 *
 * The pill pulls itself back toward the bar's edge, and the reason is optical
 * rather than numeric. A bar pads for a WORD, so the same inset that looks right
 * beside text looks like a gap beside a filled pill; the pill has to sit
 * closer for the two to read as one object. The correction lives at the pill
 * rather than as a smaller `pr` on the bar because A BADGE IS CONDITIONAL — the
 * brand island renders one in demo mode and another that hides itself at runtime
 * after a fetch — and a bar cannot pad itself differently for a child that
 * never renders. With no badge, the bar's own even padding is what shows,
 * which is the case that was wrong: the wordmark sat 6px from the edge on one
 * side and 12px on the other.
 *
 * A badge composes with the bar controls' height but not with their box: it is
 * sized by its text, not by the bar's control grid.
 */
