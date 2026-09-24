"use client";

/**
 * PlaygroundScene — the RENDER half of /{locale}/playground: one room, one
 * static whole-room camera, no corridor, no player, no HUD.
 *
 * The scene deliberately REPLICATES the game world's renderer contract
 * (world-contract.ts's GAME_SETTINGS, applied by the shared canvas the game
 * world mounts into): AgX tone mapping, PCF ("percentage") shadow map, the
 * same key/fill/ambient hierarchy (directional sun + the scene-wide
 * Lightformer IBL + the palette-scaled ambient floor), the same N8AO/Bloom/
 * Vignette post chain, and the stage-pool disc under the diorama — so a
 * playground screenshot matches what the corridor walk would show. The room
 * itself is the existing SpaceScene renderer fed the SAME pure inputs the
 * door manager feeds it (compileSpaceRecipe on the playground slice id,
 * lib/game/playground.ts), with a fixed door at the corridor's north wall
 * and a parked playerRef; `roomDoors` stays absent — the doorless
 * derivation describeRoom reports by default, so picture and data panel
 * agree by construction.
 */

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type JSX,
  type MutableRefObject,
} from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Environment,
  Lightformer,
  OrthographicCamera,
} from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, Vignette } from "@react-three/postprocessing";
import { SpaceScene } from "@/components/game/space";
import { CORRIDOR_WIDTH, type DoorRef } from "@/lib/game/hotel";
import { compileSpaceRecipe } from "@/lib/game/space-recipe";
import type { SpaceRecipe } from "@/lib/game/space-types";
import { scaledRecipeFor, scaledWallHeight } from "@/lib/game/room-plan";
import {
  playgroundFrameFor,
  type PlaygroundFrame,
} from "@/lib/game/playground";
import {
  AO_DISTANCE_FALLOFF,
  AO_INTENSITY,
  AO_RADIUS,
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_SMOOTHING,
  BLOOM_LUMINANCE_THRESHOLD,
  ENV_FORMERS,
  ENV_INTENSITY,
  ENV_RESOLUTION,
  POST_MSAA_SAMPLES,
  ROOM_INTERIOR_SUN_FILL,
  SPACE_AMBIENT_SCALE,
  STAGE_BACKDROP_LIFT,
  STAGE_BACKDROP_RADIUS,
  STAGE_BACKDROP_Y,
  SUN_BASE_COLOR,
  SUN_BASE_INTENSITY,
  SUN_OFFSET,
  SUN_SHADOW_BIAS,
  SUN_SHADOW_EXTENT,
  SUN_SHADOW_FAR,
  SUN_SHADOW_MAP_SIZE,
  SUN_SHADOW_NEAR,
  SUN_SHADOW_NORMAL_BIAS,
  VIGNETTE_DARKNESS,
  VIGNETTE_OFFSET,
} from "@/lib/game/tuning/render";

/** The door hangs on the corridor's north wall at x = 0 — the room grows
 * outward to +z, footprint z ∈ [DOOR_Z, DOOR_Z + extent]. */
const DOOR_Z = CORRIDOR_WIDTH / 2;

/** Camera offset direction (unit) — the game's fixed 45° dollhouse angle
 * (tuning/room.ts CAM_OFFSET's direction), just parked farther out. */
const CAM_DIR = new THREE.Vector3(-12, 16, 12).normalize();

/** Radial gradient for the stage pool — the same generated-DataTexture
 * approach as game-canvas's StageBackdrop (no assets). */
function createStageGradientTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = 1 - r * r * (3 - 2 * r);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** The static whole-room frame: drei gives the ortho camera pixel-based
 * bounds (left/right/±size/2 — verified in drei's source), so `zoom` =
 * viewport px ÷ world meters converts the pure frame's required half-height
 * into the zoom that shows exactly the whole plan at any canvas size. */
function RoomCamera({ frame }: { frame: PlaygroundFrame }): JSX.Element {
  const size = useThree((s) => s.size);
  const ref = useRef<THREE.OrthographicCamera>(null);
  const distance = frame.halfHeight * 6 + 60;
  useLayoutEffect(() => {
    const cam = ref.current;
    if (!cam) return;
    cam.position.set(
      frame.centerX + CAM_DIR.x * distance,
      CAM_DIR.y * distance,
      frame.centerZ + CAM_DIR.z * distance,
    );
    cam.lookAt(frame.centerX, 0, frame.centerZ);
  }, [frame, distance]);
  return (
    <OrthographicCamera
      ref={ref}
      makeDefault
      near={0.1}
      far={distance + 120}
      zoom={size.height / (2 * frame.halfHeight)}
    />
  );
}

/** Static one-room atmosphere: the game's resolveAtmosphere targets applied
 * directly (no lerp — the room never changes mid-mount): background = the
 * recipe's atmosphere fog, sun tinted/scaled by the palette, interior rooms
 * drop the sun to fill level (B.13 摄影棚论 — the room's own fixtures carry
 * the key), ambient at the palette value scaled into the hierarchy. The sun
 * parks over the room with a shadow frustum wide enough to cover the whole
 * footprint (the game grows the same box by the room zoom pull-back). */
function RoomAtmosphere({
  frame,
  fog,
  sunColor,
  sunIntensity,
  ambient,
  shadowExtent,
}: {
  frame: PlaygroundFrame;
  fog: string;
  sunColor: string;
  sunIntensity: number;
  ambient: number;
  shadowExtent: number;
}): JSX.Element {
  const [sunTarget] = useMemo(() => {
    const t = new THREE.Object3D();
    t.position.set(frame.centerX, 0, frame.centerZ);
    return [t];
  }, [frame]);
  return (
    <>
      <color attach="background" args={[fog]} />
      <ambientLight intensity={ambient} />
      <primitive object={sunTarget} />
      <directionalLight
        castShadow
        target={sunTarget}
        position={[
          frame.centerX + SUN_OFFSET.x,
          SUN_OFFSET.y,
          frame.centerZ + SUN_OFFSET.z,
        ]}
        intensity={sunIntensity}
        color={sunColor || SUN_BASE_COLOR}
        shadow-mapSize={[SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE]}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-camera-near={SUN_SHADOW_NEAR}
        shadow-camera-far={SUN_SHADOW_FAR}
        shadow-bias={SUN_SHADOW_BIAS}
        shadow-normalBias={SUN_SHADOW_NORMAL_BIAS}
      />
    </>
  );
}

/** The stage pool under the diorama — game-canvas's StageBackdrop with the
 * lerp frozen (one room, one mood): the fog hue lifted toward white, parked
 * under the room's center. */
function StagePool({
  frame,
  color,
}: {
  frame: PlaygroundFrame;
  color: string;
}): JSX.Element {
  const gradient = useMemo(() => createStageGradientTexture(), []);
  const poolColor = useMemo(
    () =>
      new THREE.Color(color).lerp(new THREE.Color("#ffffff"), STAGE_BACKDROP_LIFT),
    [color],
  );
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[frame.centerX, STAGE_BACKDROP_Y, frame.centerZ]}
    >
      <circleGeometry args={[STAGE_BACKDROP_RADIUS, 64]} />
      <meshBasicMaterial
        map={gradient}
        color={poolColor}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

/** Everything inside the canvas: the frame derives from the canvas's own
 * aspect (via useThree), so the camera fit reacts to resizes. */
function RoomWorld({
  sliceId,
  recipe,
  width,
  extent,
  wallHeight,
  playerRef,
}: {
  sliceId: string;
  recipe: SpaceRecipe;
  width: number;
  extent: number;
  wallHeight: number;
  playerRef: MutableRefObject<{ x: number; z: number }>;
}): JSX.Element {
  const size = useThree((s) => s.size);
  const frame = playgroundFrameFor({
    width,
    extent,
    doorZ: DOOR_Z,
    wallHeight,
    aspect: size.width / Math.max(1, size.height),
  });
  const shadowExtent = Math.max(SUN_SHADOW_EXTENT, frame.groundRadius * 1.3);
  const door: DoorRef = {
    index: 0,
    side: "north",
    sliceId,
    x: 0,
    z: DOOR_Z,
  };
  const palette = recipe.palette;
  const sunIntensity =
    SUN_BASE_INTENSITY *
    palette.sunIntensity *
    (recipe.worldClass === "interior" ? ROOM_INTERIOR_SUN_FILL : 1);
  const ambient = palette.ambient * SPACE_AMBIENT_SCALE;
  return (
    <>
      <RoomCamera frame={frame} />
      <RoomAtmosphere
        frame={frame}
        fog={palette.fog}
        sunColor={palette.sunColor}
        sunIntensity={sunIntensity}
        ambient={ambient}
        shadowExtent={shadowExtent}
      />
      <StagePool frame={frame} color={palette.fog} />
      {/* The one scene-wide IBL fill — the same Lightformer cards the game
          bakes (no HDRI, no assets). */}
      <Environment resolution={ENV_RESOLUTION} environmentIntensity={ENV_INTENSITY}>
        {ENV_FORMERS.map((f, i) => (
          <Lightformer
            key={i}
            form={f.form}
            color={f.color}
            intensity={f.intensity}
            position={[f.position[0], f.position[1], f.position[2]]}
            rotation={[f.rotation[0], f.rotation[1], f.rotation[2]]}
            scale={[f.scale[0], f.scale[1], f.scale[2]]}
          />
        ))}
      </Environment>
      <SpaceScene
        key={sliceId}
        recipe={recipe}
        door={door}
        playerRef={playerRef}
        corridorGone
        fade="in"
        onFadedOut={() => undefined}
      />
      <EffectComposer multisampling={POST_MSAA_SAMPLES}>
        <N8AO
          halfRes
          quality="performance"
          intensity={AO_INTENSITY}
          aoRadius={AO_RADIUS}
          distanceFalloff={AO_DISTANCE_FALLOFF}
        />
        <Bloom
          mipmapBlur
          intensity={BLOOM_INTENSITY}
          luminanceThreshold={BLOOM_LUMINANCE_THRESHOLD}
          luminanceSmoothing={BLOOM_LUMINANCE_SMOOTHING}
        />
        <Vignette offset={VIGNETTE_OFFSET} darkness={VIGNETTE_DARKNESS} />
      </EffectComposer>
    </>
  );
}

export function PlaygroundScene({ sliceId }: { sliceId: string }): JSX.Element {
  // The same pure inputs the door manager assembles (game-canvas.tsx): the
  // recipe off the slice id, then the scaled view the renderer builds at.
  const recipe = useMemo(() => compileSpaceRecipe(sliceId), [sliceId]);
  const { recipe: scaled, scale } = useMemo(
    () => scaledRecipeFor(recipe, 0),
    [recipe],
  );
  const wallHeight = scaledWallHeight(scale.factor);
  // Parked player: standing on the cleared strip just inside the door —
  // only the water-wade probe reads it; fixed, so renders stay deterministic.
  const playerRef = useRef({ x: 0, z: DOOR_Z + 2 });
  return (
    <Canvas
      dpr={[1, 2]}
      shadows="percentage"
      gl={{ antialias: true, toneMapping: THREE.AgXToneMapping }}
    >
      <RoomWorld
        key={sliceId}
        sliceId={sliceId}
        recipe={recipe}
        width={scaled.width}
        extent={scaled.size.extent}
        wallHeight={wallHeight}
        playerRef={playerRef}
      />
    </Canvas>
  );
}
