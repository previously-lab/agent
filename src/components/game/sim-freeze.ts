/**
 * The simulation freeze (v0.28 step 1 — the Control-style pause), now
 * delegating to the game clock (v0.28 step 2, game-time.ts). While the
 * document tier sits over the hotel (the shell's `gameSuspended` state
 * and every pause-mode move), the world's SIMULATION stops advancing:
 * movement, the door manager, the clamps and the HUD arbitration
 * early-return in GameLoop, and the terminal/paper interactions refuse
 * to fire.
 *
 * RENDERING STOPS BEHIND THE DOCUMENTS: the shell drops the shared canvas
 * to `frameloop="never"` for a fullscreen pause, or to "demand" for this
 * document pause (see `canvasPolicy` in world-contract.ts) — demand runs
 * only the finite frames the archive field's `<Html>` portals and
 * virtual-list range ask for (its ref-only scroll gestures request them
 * explicitly through the world-slot channel), and the game's
 * EffectComposer is disabled for the whole pause, so a demand frame does
 * not repaint the hotel by itself. The ONE-SHOT EXCEPTION: when a
 * suspended resize/DPR change clears the canvas, the game owner's
 * frozen-frame repair repaints exactly once through the game's own
 * composer (frozen-frame.ts) — no other suspended frame ever paints.
 *
 * WHY A DELEGATED SINGLETON — AND WHY THE CLOCK. GAME_SIM_FREEZE used to
 * be a standalone record the shell wrote and GameLoop read; it is now a
 * compatibility view over GAME_TIME, because the freeze is really a
 * property of the game's own clock: setGameFrozen forces the game delta
 * to 0 and the thaw discards the first raw delta (the R3F clock resets
 * across the always↔demand flip — game-time.ts). Reading `.frozen` still
 * answers "is the simulation frozen"; writing it drives the clock.
 * New code should call setGameFrozen directly; the app-shell keeps
 * writing this record until its lane lands.
 *
 * WHY A MODULE SINGLETON AT ALL. The shell (React) writes it twice per
 * move; the GameLoop / interaction handlers read it inside frame loops
 * and event handlers that must not re-render React — the same idiom as
 * WORLD_TRANSITION (world-transition.ts), deliberately a separate record:
 * the transition's `active` is true only DURING a move, this flag is true
 * for the whole time the reader sits over the world. What freezes is the
 * world's own frame work; the shell owns the loop.
 */
import { GAME_TIME, setGameFrozen } from "./game-time";

export const GAME_SIM_FREEZE: { frozen: boolean } = {
  get frozen(): boolean {
    return GAME_TIME.frozen;
  },
  set frozen(value: boolean) {
    setGameFrozen(value);
  },
};
