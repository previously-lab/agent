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
