/**
 * The shared slice cursor's quiet-report channel (v0.13 §6 一个游标) — a
 * module-level hook, exactly the idiom `world-transition.ts`'s
 * `WORLD_TRANSITION.hooks.enter` uses for the room → catalog entrance.
 *
 * WHY A MODULE HOOK AND NOT CONTEXT. The world's roaming moves the same
 * cursor the card stack's scrolling moves: the room the reader stands in IS
 * the slice the cursor names. The reporter is game-canvas.tsx — a client
 * component whose import chain the pure-function vitest suites
 * (tests/lib/game/lobby, strand-transition) already load, and pulling the
 * shell provider (and with it the chat component tree) into that chain just
 * to reach a context would be the most expensive possible way to deliver
 * one string. So the provider REGISTERS the sink here (its `reportCursor`),
 * and the world fires it — the same shape as the terminal entrance, which
 * the canvas also fires and the shell also owns.
 *
 * This is the QUIET half of the cursor contract: a report moves the cursor
 * and nothing else. Steering the world is the nav actions' business
 * (shell-nav.ts), never a report's.
 */
export const CURSOR_HOOKS: {
  /** The provider's quiet cursor write, registered while it is mounted. */
  report: ((sliceId: string | null) => void) | null;
} = { report: null };
