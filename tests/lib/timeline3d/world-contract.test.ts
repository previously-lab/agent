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
