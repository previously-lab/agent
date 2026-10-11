/**
 * The simulation freeze (v0.28 step 1 — the Control-style pause). While the
 * document tier sits over the hotel (the shell's `gameSuspended` state and
 * every pause-mode move), the world's SIMULATION stops advancing: movement,
 * the door manager, the clamps and the HUD arbitration early-return in
 * GameLoop, and the terminal/paper interactions refuse to fire. RENDERING
 * CONTINUES on the frozen frame — the shared canvas's frame loop also drives
 * the desk's `<Html transform>` portals and zoom camera, so the loop itself
 * can never stop; what freezes is the world's own frame work. Ambient shader
 * animation (water caustics, the hologram's pulse) keeps ticking — it lives
 * under the blur layer, where the residue is invisible.
 *
 * WHY A MODULE SINGLETON. The shell (React) writes it twice per move; the
 * GameLoop / interaction handlers read it inside frame loops and event
 * handlers that must not re-render React — the same idiom as
 * WORLD_TRANSITION (world-transition.ts), deliberately a separate record:
 * the transition's `active` is true only DURING a move, this flag is true
 * for the whole time the reader sits over the world.
 */
export const GAME_SIM_FREEZE = { frozen: false };
