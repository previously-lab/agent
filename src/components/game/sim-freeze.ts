/**
 * The simulation freeze (v0.28 step 1 — the Control-style pause). While the
 * document tier sits over the hotel (the shell's `gameSuspended` state and
 * every pause-mode move), the world's SIMULATION stops advancing: movement,
 * the door manager, the clamps and the HUD arbitration early-return in
 * GameLoop, and the terminal/paper interactions refuse to fire. RENDERING
 * STOPS BEHIND THE DOCUMENTS: the shell drops the shared canvas to
 * `frameloop="never"` for a fullscreen pause, or to "demand" for this
 * document pause (see `canvasPolicy` in world-contract.ts) — demand runs
 * only the finite frames the archive field's `<Html>` portals and
 * virtual-list range ask for (its ref-only scroll gestures request them
 * explicitly through the world-slot channel), so the frozen hotel frame
 * stays bit-identical while idle, and the game's EffectComposer is
 * disabled for the whole pause so a demand frame never repaints the
 * hotel. What freezes is the world's own frame work; the shell owns the
 * loop.
 *
 * WHY A MODULE SINGLETON. The shell (React) writes it twice per move; the
 * GameLoop / interaction handlers read it inside frame loops and event
 * handlers that must not re-render React — the same idiom as
 * WORLD_TRANSITION (world-transition.ts), deliberately a separate record:
 * the transition's `active` is true only DURING a move, this flag is true
 * for the whole time the reader sits over the world.
 */
export const GAME_SIM_FREEZE = { frozen: false };
