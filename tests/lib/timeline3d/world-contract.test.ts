/**
 * The world-switch contract (§14.2), locked by state assertions over the
 * sequence the doc names: enter A → leave → enter B → leave → re-enter A.
 * The target is a structural stand-in for { gl: WebGLRenderer, scene: Scene }
 * so the test runs in the node environment — the values asserted are the
 * three.js enum members the real renderer carries.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyWorldContract,
  canvasPolicy,
  canvasPolicyWorld,
  type WorldContractTarget,
} from "@/components/timeline-3d/world-contract";

function makeTarget(): WorldContractTarget {
  // The canvas's birth state: R3F's defaults — ACESFilmic tone mapping,
  // shadow map off, transparent scene.
  return {
    gl: {
      toneMapping: THREE.ACESFilmicToneMapping,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    },
    scene: { background: null, fog: null },
  };
}

describe("world contract (§14.2)", () => {
  it("entering the game world applies AgX tone mapping and percentage shadows", () => {
    const target = makeTarget();
    applyWorldContract(target, "game");
    expect(target.gl.toneMapping).toBe(THREE.AgXToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(true);
    expect(target.gl.shadowMap.type).toBe(THREE.PCFShadowMap);
  });

  it("entering the field world keeps the v0.10 renderer values (ACES, no shadows)", () => {
    const target = makeTarget();
    applyWorldContract(target, "field");
    expect(target.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(false);
    expect(target.scene.background).toBeNull();
    expect(target.scene.fog).toBeNull();
  });

  it("enter A → leave → enter B → leave → re-enter A: no state leaks either way", () => {
    const target = makeTarget();

    // Enter FIELD.
    const leaveField = applyWorldContract(target, "field");
    expect(target.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(false);

    // Leave FIELD, enter GAME.
    leaveField();
    const leaveGame = applyWorldContract(target, "game");
    expect(target.gl.toneMapping).toBe(THREE.AgXToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(true);
    expect(target.gl.shadowMap.type).toBe(THREE.PCFShadowMap);

    // The game's subtree attaches its atmosphere while it is up.
    target.scene.background = new THREE.Color("#0a0a0a");

    // Leave GAME: the field must not inherit the game's atmosphere —
    // background/fog come off with the world, tone mapping and shadows
    // restore to what the canvas had before the game entered.
    leaveGame();
    expect(target.scene.background).toBeNull();
    expect(target.scene.fog).toBeNull();
    expect(target.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(false);

    // Re-enter FIELD: the field's own values, with no trace of the game.
    applyWorldContract(target, "field");
    expect(target.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(false);
    expect(target.scene.background).toBeNull();
  });

  it("entering the field clears a stale game atmosphere even without a prior leave", () => {
    const target = makeTarget();
    applyWorldContract(target, "game");
    target.scene.background = new THREE.Color("#111111");
    target.scene.fog = new THREE.Fog("#111111", 1, 10);
    // A defensive re-entry (the shell applies the contract on every world
    // change; a missed exit must not poison the field).
    applyWorldContract(target, "field");
    expect(target.scene.background).toBeNull();
    expect(target.scene.fog).toBeNull();
    expect(target.gl.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(target.gl.shadowMap.enabled).toBe(false);
  });
});

describe("canvas render policy", () => {
  it("an active game world caps DPR at 1.5 and runs the loop", () => {
    expect(canvasPolicy("game", false, false)).toEqual({
      dpr: [1, 1.5],
      frameloop: "always",
    });
  });

  it("an active field world keeps the historical DPR range [1, 2]", () => {
    expect(canvasPolicy("field", false, false)).toEqual({
      dpr: [1, 2],
      frameloop: "always",
    });
  });

  it("the fullscreen pause stops the loop entirely in either world", () => {
    expect(canvasPolicy("game", true, false).frameloop).toBe("never");
    expect(canvasPolicy("field", true, false).frameloop).toBe("never");
  });

  it("the document pause is demand: finite frames, no idle redraw", () => {
    // The DOM desk's <Html> portals and virtual-list range mount and
    // respond through invalidate(); the loop does NOT run continuously.
    expect(canvasPolicy("game", false, true).frameloop).toBe("demand");
    expect(canvasPolicy("field", false, true).frameloop).toBe("demand");
  });

  it("a fullscreen pause over the suspended hotel is still fully never", () => {
    // paused wins over suspended — demand is only for the document pause.
    expect(canvasPolicy("game", true, true).frameloop).toBe("never");
    expect(canvasPolicy("field", true, true).frameloop).toBe("never");
  });

  it("a paused or suspended loop keeps the world's DPR policy — pause, never unmount", () => {
    expect(canvasPolicy("game", true, false).dpr).toEqual([1, 1.5]);
    expect(canvasPolicy("game", false, true).dpr).toEqual([1, 1.5]);
    expect(canvasPolicy("field", false, true).dpr).toEqual([1, 2]);
  });

  it("resume: un-pausing an un-suspending game returns to always at the game DPR", () => {
    expect(canvasPolicy("game", true, false).frameloop).toBe("never");
    expect(canvasPolicy("game", false, false)).toEqual({
      dpr: [1, 1.5],
      frameloop: "always",
    });
    expect(canvasPolicy("game", false, true).frameloop).toBe("demand");
    expect(canvasPolicy("game", false, false).frameloop).toBe("always");
  });
});

describe("canvas policy world", () => {
  it("a game→field PAUSE move keeps the game (the frozen frame) as the policy world", () => {
    // worlds = [leaving, entering]; a pause move freezes the leaving world
    // on the canvas — its DPR must survive the whole pause.
    expect(canvasPolicyWorld(["game", "field"], true, true)).toBe("game");
  });

  it("a field→game pause/resume keeps the field until the pause ends", () => {
    expect(canvasPolicyWorld(["field", "game"], true, true)).toBe("field");
  });

  it("a dissolve follows the entering world in both directions", () => {
    expect(canvasPolicyWorld(["field", "game"], true, false)).toBe("game");
    expect(canvasPolicyWorld(["game", "field"], true, false)).toBe("field");
  });

  it("a settled state, including suspended, uses worlds[0]", () => {
    expect(canvasPolicyWorld(["field"], false, false)).toBe("field");
    expect(canvasPolicyWorld(["game"], false, false)).toBe("game");
    // Suspended is worlds = ["game", "field"] with no transition running —
    // the frozen game's DPR.
    expect(canvasPolicyWorld(["game", "field"], false, false)).toBe("game");
  });

  it("an empty list or a missing slot returns null (the canvas fallback)", () => {
    expect(canvasPolicyWorld([], false, false)).toBeNull();
    expect(canvasPolicyWorld([], true, true)).toBeNull();
    // A dissolve with no entering world mounted: the slot is missing, so
    // the canvas's null fallback applies.
    expect(canvasPolicyWorld(["game"], true, false)).toBeNull();
  });
});
