/**
 * The world transition primitive — the timing beats, the dissolve ramp, the
 * contract pin schedule, and the scripted hotel shot's geometry.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  contractPinAt,
  DISSOLVE_END,
  DISSOLVE_START,
  eyePoseFor,
  fieldLayerAlpha,
  hotelShotPose,
  SHOT_EYE_BACKOFF,
  SHOT_EYE_HEIGHT,
  SHOT_LOOK_HEIGHT,
  SHOT_ZOOM_CLOSE,
  shotPath,
  smooth01,
  transitionPhase,
  TRANSITION_PIN,
  WORLD_TRANSITION,
  type AnchorPose,
  type FollowPose,
} from "@/lib/timeline3d/world-transition";

const ANCHOR: AnchorPose = { x: 2, z: -3, faceX: 0, faceZ: -1, has: true };
const FOLLOW: FollowPose = {
  x: -10,
  y: 16,
  z: 9,
  lookX: 2,
  lookY: 0,
  lookZ: -3,
  zoom: 44,
};

describe("transitionPhase", () => {
  it("splits the move into camera, dissolve and settle beats", () => {
    expect(transitionPhase(0)).toBe("camera");
    expect(transitionPhase(DISSOLVE_START - 0.01)).toBe("camera");
    expect(transitionPhase(DISSOLVE_START)).toBe("dissolve");
    expect(transitionPhase((DISSOLVE_START + DISSOLVE_END) / 2)).toBe(
      "dissolve",
    );
    expect(transitionPhase(DISSOLVE_END)).toBe("settle");
    expect(transitionPhase(1)).toBe("settle");
  });
});

describe("smooth01", () => {
  it("clamps and eases", () => {
    expect(smooth01(-1)).toBe(0);
    expect(smooth01(0)).toBe(0);
    expect(smooth01(1)).toBe(1);
    expect(smooth01(2)).toBe(1);
    expect(smooth01(0.5)).toBeCloseTo(0.5);
    // Eased, not linear: the first half stays below the linear ramp.
    expect(smooth01(0.25)).toBeLessThan(0.25);
  });
});

describe("fieldLayerAlpha", () => {
  it("ramps 0→1 entering the field and 1→0 leaving it", () => {
    // game → field: the game owns the screen until the dissolve.
    expect(fieldLayerAlpha(0, "game")).toBe(0);
    expect(fieldLayerAlpha(DISSOLVE_START, "game")).toBe(0);
    expect(fieldLayerAlpha((DISSOLVE_START + DISSOLVE_END) / 2, "game")).toBeCloseTo(0.5);
    expect(fieldLayerAlpha(DISSOLVE_END, "game")).toBe(1);
    expect(fieldLayerAlpha(1, "game")).toBe(1);
    // field → game is the mirror.
    expect(fieldLayerAlpha(0, "field")).toBe(1);
    expect(fieldLayerAlpha(DISSOLVE_END, "field")).toBe(0);
    expect(fieldLayerAlpha(1, "field")).toBe(0);
  });
});

describe("contractPinAt", () => {
  it("pins the leaving world's values until the settle beat", () => {
    expect(contractPinAt(0, "game", "field")).toBe(TRANSITION_PIN.game);
    expect(contractPinAt(DISSOLVE_END - 0.01, "game", "field")).toBe(
      TRANSITION_PIN.game,
    );
    expect(contractPinAt(DISSOLVE_END, "game", "field")).toBe(
      TRANSITION_PIN.field,
    );
    expect(contractPinAt(1, "field", "game")).toBe(TRANSITION_PIN.game);
  });

  it("game pins NoToneMapping (the composer's live value), field pins ACES", () => {
    expect(TRANSITION_PIN.game.toneMapping).toBe(THREE.NoToneMapping);
    expect(TRANSITION_PIN.game.shadowMapEnabled).toBe(true);
    expect(TRANSITION_PIN.field.toneMapping).toBe(
      THREE.ACESFilmicToneMapping,
    );
    expect(TRANSITION_PIN.field.shadowMapEnabled).toBe(false);
  });
});

describe("eyePoseFor", () => {
  it("stands back along the facing at eye height, looking at the screen", () => {
    const pose = eyePoseFor(ANCHOR, 44);
    expect(pose.x).toBeCloseTo(2);
    expect(pose.z).toBeCloseTo(-3 - SHOT_EYE_BACKOFF);
    expect(pose.y).toBe(SHOT_EYE_HEIGHT);
    expect(pose.lookX).toBeCloseTo(2);
    expect(pose.lookY).toBe(SHOT_LOOK_HEIGHT);
    expect(pose.lookZ).toBeCloseTo(-3);
    expect(pose.zoom).toBeCloseTo(44 * SHOT_ZOOM_CLOSE);
  });
});

describe("shotPath", () => {
  it("hits the follow pose at t=0 and the eye pose at t=1", () => {
    const eye = eyePoseFor(ANCHOR, FOLLOW.zoom);
    const atStart = shotPath(0, eye, FOLLOW);
    expect(atStart.x).toBeCloseTo(FOLLOW.x);
    expect(atStart.y).toBeCloseTo(FOLLOW.y);
    expect(atStart.zoom).toBeCloseTo(FOLLOW.zoom);
    const atEnd = shotPath(1, eye, FOLLOW);
    expect(atEnd.x).toBeCloseTo(eye.x);
    expect(atEnd.y).toBeCloseTo(eye.y);
    expect(atEnd.zoom).toBeCloseTo(eye.zoom);
  });
});

describe("hotelShotPose", () => {
  it("descends while leaving the hotel and holds the eye pose through the dissolve", () => {
    const early = hotelShotPose(0.01, "game", "field", false, ANCHOR, FOLLOW);
    expect(early).not.toBeNull();
    // Much closer to the follow height than to the eye height.
    expect(Math.abs(early!.y - FOLLOW.y)).toBeLessThan(
      Math.abs(early!.y - SHOT_EYE_HEIGHT),
    );
    const held = hotelShotPose(
      (DISSOLVE_START + DISSOLVE_END) / 2,
      "game",
      "field",
      false,
      ANCHOR,
      FOLLOW,
    );
    expect(held!.y).toBeCloseTo(SHOT_EYE_HEIGHT);
    expect(held!.zoom).toBeCloseTo(FOLLOW.zoom * SHOT_ZOOM_CLOSE);
  });

  it("holds the eye pose while entering, then rises exactly onto the follow pose", () => {
    const hidden = hotelShotPose(0.2, "field", "game", false, ANCHOR, FOLLOW);
    expect(hidden!.y).toBeCloseTo(SHOT_EYE_HEIGHT);
    const risen = hotelShotPose(1, "field", "game", false, ANCHOR, FOLLOW);
    expect(risen!.x).toBeCloseTo(FOLLOW.x);
    expect(risen!.y).toBeCloseTo(FOLLOW.y);
    expect(risen!.zoom).toBeCloseTo(FOLLOW.zoom);
  });

  it("defers to the follow rig without an anchor or under reduced motion", () => {
    expect(
      hotelShotPose(0.5, "game", "field", false, { ...ANCHOR, has: false }, FOLLOW),
    ).toBeNull();
    expect(hotelShotPose(0.5, "game", "field", true, ANCHOR, FOLLOW)).toBeNull();
  });
});

describe("WORLD_TRANSITION", () => {
  it("starts idle with a clear anchor and no hook", () => {
    expect(WORLD_TRANSITION.active).toBe(false);
    expect(WORLD_TRANSITION.progress).toBe(0);
    expect(WORLD_TRANSITION.anchor.has).toBe(false);
    expect(WORLD_TRANSITION.hooks.enter).toBeNull();
  });
});
