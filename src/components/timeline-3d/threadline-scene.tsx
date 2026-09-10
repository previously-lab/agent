"use client";

/**
 * ThreadlineScene (Rev 4, P1) — the timeline view's LEFT band as a lit,
 * duotone, infinitely-tiling DNA thread bundle.
 *
 * A perspective R3F canvas fills the narrow band. A blue brand core runs the
 * full height; two families of helices (cool clockwise, warm counter-clockwise)
 * wrap it with fake upper-left directional light, crossing darkening, and a
 * slowly drifting highlight band. Strand selection triggers an aperture focus:
 * the selected thread straightens and lights up, the rest dim to a stage
 * backdrop, and the core stays crisp. The braid tiles vertically by period so
 * it never runs out, no matter how far the user scrolls or zooms.
 *
 * Convergence layer: where the card field starts a new row (slice/day/week,
 * per zoom level) — or where the chat stream shows a slice seam in chat view —
 * the helices pinch toward the core with a Gaussian radius envelope and relax
 * back — the weave gathers at each node, the core and companion lines stay
 * straight.
 *
 * View-switch bloom (Rev 5): the chat ↔ timeline transition animates the
 * bundle itself instead of snapping between two parameter sets. An
 * `expanded` prop drives a 0..1 expand factor eased over a fixed 500 ms tween
 * that matches the AxisBand's CSS width transition. Per frame the factor
 * lerps the helix radius factor (0.22 ↔ 0.30), rotates each family's phases
 * between their collapsed (6 evenly spaced) and open (10 evenly spaced)
 * slots so the weave visibly unfolds out of the core, and fades the four
 * "extra" fibers per family in/out (they stack under visible slots when
 * collapsed). reducedMotion snaps the factor to its target.
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { useTheme } from "@teispace/next-themes";
import { oklchToHex } from "@/lib/timeline3d/layout";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import {
  radiusEnvelopeAt,
  screenFractionToWorldY,
} from "@/lib/timeline3d/convergence";

const FOV = 30;
const BASE_Z = 9;
const VIEWPORT_TWIST_PERIOD = 0.35;
const DESKTOP_CW_COUNT = 10;
const DESKTOP_CCW_COUNT = 10;
/** Family slots that survive collapse — the narrow bundle's 6+6 weave. */
const NARROW_FAMILY_SLOTS = 6;
const DESKTOP_RADIUS_FACTOR = 0.30;
const NARROW_RADIUS_FACTOR = 0.30;
/** The weave always lays itself out for a band at least this wide — a slim
 *  strip (chat view, phone timeline) renders a true miniature of the wide
 *  braid instead of squeezing the radius into invisibility. */
const VIRTUAL_MIN_BAND_PX = 120;
const SELECTED_OFFSET_FACTOR = 0.04;
const ANGLE_EASE_SPEED = 5;
const FOCUS_SMOOTH_SPEED = 5;
const CAMERA_SMOOTH_SPEED = 6;
const ZOOM_Z_MULTIPLIER = 0.18;
const FOCUS_CAMERA_MULT = 0.55;
const SAMPLE_PX_STEP = 12;
/** Narrow bands sample denser: 12 px steps read as polyline facets in a
 *  ~56 px-wide band, so the step tightens to keep the weave smooth. */
const NARROW_SAMPLE_PX_STEP = 8;
const ROTATION_SPEED = 0.04;
const LIGHT_DRIFT_PERIOD = 25;
const PULSE_DURATION = 1.2;
const PULSE_WIDTH_FACTOR = 0.35;
const PERIOD_COUNT = 8;
const NARROW_BAND_PX = 100;
/** View-switch bloom tween — kept in step with the AxisBand width transition
 *  (Tailwind `duration-500`). */
const EXPAND_DURATION_MS = 500;
/** Convergence pinch: radius at a row-start anchor is 1 - depth of normal. */
const CONVERGENCE_DEPTH = 0.7;
/** Gaussian width as a fraction of the shared viewport world height. */
const CONVERGENCE_SIGMA_FACTOR = 0.05;

const AMBIENT = 0.22;
const DIFFUSE = 0.78;
const CROSSING_DARKEN = 0.18;
const CROSSING_SHARPNESS = 4.0;

const CW_GRAY_LIGHT = "#475569";
const CCW_GRAY_LIGHT = "#57534e";
const CW_GRAY_DARK = "#94a3b8";
const CCW_GRAY_DARK = "#a8a29e";

const SELECTED_INK_LIGHT = "#111827";
const SELECTED_INK_DARK = "#f5f5dc";
const BACKDROP_DARKEN_LIGHT = "#4b5563";
const BACKDROP_DARKEN_DARK = "#1f2937";

export interface ThreadlineSceneProps {
  /** Strand names (display order = fiber order), capped by the caller. */
  strands: string[];
  /** The filter's selection — null = no focus. */
  selected: string | null;
  /** Card-field scroll progress 0..1 (0 = oldest/top, 1 = now/bottom). */
  progressRef: React.MutableRefObject<number>;
  /** Visible date range of the catalog. */
  range: { oldest: string; now: string };
  /** Current zoom level, written by `CardField`. */
  levelRef: React.MutableRefObject<StackLevel>;
  /** Screen-Y fractions (0=top, 1=bottom) of the current view's nodes —
   *  written by the card field (row starts) in timeline view and by the chat
   *  stream (slice seam rows) in chat view; the helices converge at these
   *  heights. */
  anchorsRef: React.MutableRefObject<number[]>;
  /** Whether to skip motion. */
  reducedMotion: boolean;
  /** Target weave state: true = timeline view (bloomed), false = chat view
   *  (collapsed against the core). The scene tweens a 0..1 expand factor
   *  toward it; the AxisBand drives it from `!narrow`. */
  expanded: boolean;
}

interface ThreadData {
  name: string;
  isReal: boolean;
  phase: number;
  /** Collapsed-slot phase (6 evenly spaced family slots) — the phase the
   *  fiber rotates to when the bundle collapses. */
  phaseNarrow: number;
  /** Family slot with no collapsed position (slots 6..9): fades in/out with
   *  the expand factor instead of holding a slot. */
  extra: boolean;
  direction: number;
  baseOpacity: number;
  ys: Float32Array;
  thetaBase: Float32Array;
  radialCos: Float32Array;
  radialSin: Float32Array;
  grayR: number;
  grayG: number;
  grayB: number;
  points: THREE.Vector3Tuple[];
  colors: THREE.Color[];
}

interface BuildData {
  threads: ThreadData[];
  corePoints: THREE.Vector3Tuple[];
  companionPoints: THREE.Vector3Tuple[];
  ys: Float32Array;
  R: number;
  worldWidth: number;
  viewportWorldHeight: number;
  columnHeight: number;
  twist: number;
  turnPeriod: number;
  bgR: number;
  bgG: number;
  bgB: number;
  primary: THREE.Color;
  companion: THREE.Color;
  selectedInkR: number;
  selectedInkG: number;
  selectedInkB: number;
  backdropDarkenR: number;
  backdropDarkenG: number;
  backdropDarkenB: number;
  pulseColorR: number;
  pulseColorG: number;
  pulseColorB: number;
}

function getCssHex(variable: string): string {
  if (typeof window === "undefined") return "";
  // Resolve through a probe element so var() chains (Tailwind v4 `@theme
  // inline` defines --primary as a var reference) come out fully resolved.
  const el = document.createElement("div");
  el.style.display = "none";
  el.style.color = `var(${variable})`;
  document.body.appendChild(el);
  const value = getComputedStyle(el).color.trim();
  el.remove();
  if (!value) return "";
  if (value.startsWith("oklch")) return oklchToHex(value);
  if (value.startsWith("#") || value.startsWith("rgb")) return value;
  return "";
}

function readPrimaryAndBg(dark: boolean): {
  primary: string;
  bg: string;
} {
  const primary =
    getCssHex("--primary") || (dark ? "#3b82f6" : "#2563eb");
  const bg =
    getCssHex("--background") || (dark ? "#242426" : "#ffffff");
  return { primary, bg };
}

/**
 * Slots 0..(CW-1) are the clockwise family, the rest counter-clockwise. The
 * collapse animation hides family slots >= NARROW_FAMILY_SLOTS, so the 12
 * slots that survive — the first 6 of each family — get the highest-priority
 * names; the remaining slots take fillers. This keeps the chat view's narrow
 * bundle showing the same top strands it always did while the wide view
 * shows the full set.
 */
function slotSurvivesCollapse(i: number): boolean {
  const familySlot = i < DESKTOP_CW_COUNT ? i : i - DESKTOP_CW_COUNT;
  return familySlot < NARROW_FAMILY_SLOTS;
}

function displayNamesFor(
  strands: string[],
  selected: string | null,
  totalThreads: number,
): string[] {
  const priority: string[] = [];
  const seen = new Set<string>();
  if (selected) {
    seen.add(selected);
    priority.push(selected);
  }
  for (const s of strands) {
    if (!seen.has(s)) {
      seen.add(s);
      priority.push(s);
    }
  }
  const names: string[] = [];
  let pi = 0;
  for (let i = 0; i < totalThreads; i++) {
    if (slotSurvivesCollapse(i) && pi < priority.length) {
      names.push(priority[pi++]);
    } else {
      names.push(`__filler:${i}`);
    }
  }
  return names;
}

function computeVertexColor(
  theta: number,
  gray: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
  lightDir: THREE.Vector3,
): THREE.Color {
  const radialDir = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
  const lit = AMBIENT + DIFFUSE * Math.max(0, radialDir.dot(lightDir));
  const depthFactor = 0.2 + 0.8 * ((Math.sin(theta) + 1) / 2);
  const crossing = Math.exp(-CROSSING_SHARPNESS * Math.abs(Math.cos(theta)));
  const strength = Math.max(
    0,
    Math.min(1, lit * depthFactor * (1 - CROSSING_DARKEN * crossing)),
  );
  return new THREE.Color().lerpColors(
    new THREE.Color(bg.r, bg.g, bg.b),
    new THREE.Color(gray.r, gray.g, gray.b),
    strength,
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
}

function buildData(
  names: string[],
  width: number,
  height: number,
  dark: boolean,
  expanded: boolean,
): BuildData | null {
  if (width <= 0 || height <= 0) return null;
  const cwCount = DESKTOP_CW_COUNT;
  const ccwCount = DESKTOP_CCW_COUNT;
  const totalThreads = cwCount + ccwCount;
  const narrow = width < NARROW_BAND_PX;
  // The bundle ALWAYS carries the full fiber set; the collapsed look comes
  // from the per-frame expand factor (radius, phase rotation, extra-fiber
  // fade), not from rebuilding with fewer threads. Only the initial point
  // bake and the sampling density still key off the band width / state.
  const radiusFactor = expanded ? DESKTOP_RADIUS_FACTOR : NARROW_RADIUS_FACTOR;

  const { primary: primaryHex, bg: bgHex } = readPrimaryAndBg(dark);
  const primary = new THREE.Color(primaryHex);
  const bg = hexToRgb(bgHex);
  const companion = new THREE.Color(primaryHex).lerp(
    new THREE.Color("#ffffff"),
    0.45,
  );
  const selectedInk = hexToRgb(
    dark ? SELECTED_INK_DARK : SELECTED_INK_LIGHT,
  );
  const backdropDarken = hexToRgb(
    dark ? BACKDROP_DARKEN_DARK : BACKDROP_DARKEN_LIGHT,
  );
  const pulseColor = hexToRgb(dark ? "#22d3ee" : primaryHex);

  const worldHeight = 2 * BASE_Z * Math.tan((FOV * Math.PI) / 360);
  const worldWidth =
    (worldHeight * Math.max(width, VIRTUAL_MIN_BAND_PX)) / height;
  const viewportWorldHeight = worldHeight;
  const twist = (Math.PI * 2) / (viewportWorldHeight * VIEWPORT_TWIST_PERIOD);
  const turnPeriod = viewportWorldHeight * VIEWPORT_TWIST_PERIOD;
  const columnHeight = turnPeriod * PERIOD_COUNT;
  const R = (worldWidth / 2) * radiusFactor;
  const samplePx = narrow ? NARROW_SAMPLE_PX_STEP : SAMPLE_PX_STEP;
  const sampleStepWorld = (worldHeight / height) * samplePx;
  const nPoints = Math.max(2, Math.ceil(columnHeight / sampleStepWorld));
  const ys = new Float32Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    ys[i] = columnHeight / 2 - t * columnHeight;
  }

  const cwGray = hexToRgb(dark ? CW_GRAY_DARK : CW_GRAY_LIGHT);
  const ccwGray = hexToRgb(dark ? CCW_GRAY_DARK : CCW_GRAY_LIGHT);

  const initialLightDir = new THREE.Vector3(-0.7, 0.35, -0.62).normalize();
  const threads: ThreadData[] = names.map((name, i) => {
    const isReal = !name.startsWith("__filler:");
    const direction = i < cwCount ? 1 : -1;
    const familySlot = direction === 1 ? i : i - cwCount;
    const phase = familySlot * ((Math.PI * 2) / cwCount);
    const phaseNarrow =
      (familySlot % NARROW_FAMILY_SLOTS) *
      ((Math.PI * 2) / NARROW_FAMILY_SLOTS);
    // Extra fibers (slots 6..9) wrap onto a collapsed slot so they bloom
    // out from under the visible weave as the bundle opens.
    const extra = familySlot >= NARROW_FAMILY_SLOTS;
    // Initial bake uses the current expand state; useFrame rewrites the
    // positions every frame while the expand factor moves.
    const phase0 = expanded ? phase : phaseNarrow;
    const gray = direction === 1 ? cwGray : ccwGray;
    const baseOpacity = dark ? 0.35 : 0.55;
    const thetaBase = new Float32Array(nPoints);
    const radialCos = new Float32Array(nPoints);
    const radialSin = new Float32Array(nPoints);
    const points: THREE.Vector3Tuple[] = [];
    const colors: THREE.Color[] = [];
    for (let j = 0; j < nPoints; j++) {
      const y = ys[j];
      const theta = y * twist * direction + phase0;
      thetaBase[j] = theta;
      radialCos[j] = Math.cos(theta);
      radialSin[j] = Math.sin(theta);
      points.push([R * Math.cos(theta), y, R * Math.sin(theta)]);
      colors.push(
        computeVertexColor(theta, gray, bg, initialLightDir),
      );
    }
    return {
      name,
      isReal,
      phase,
      phaseNarrow,
      extra,
      direction,
      baseOpacity,
      ys,
      thetaBase,
      radialCos,
      radialSin,
      grayR: gray.r,
      grayG: gray.g,
      grayB: gray.b,
      points,
      colors,
    };
  });

  const corePoints: THREE.Vector3Tuple[] = [];
  const companionPoints: THREE.Vector3Tuple[] = [];
  const companionOffset = worldWidth * 0.006;
  for (let i = 0; i < nPoints; i++) {
    const y = ys[i];
    corePoints.push([0, y, 0]);
    companionPoints.push([companionOffset, y, 0]);
  }

  return {
    threads,
    corePoints,
    companionPoints,
    ys,
    R,
    worldWidth,
    viewportWorldHeight,
    columnHeight,
    twist,
    turnPeriod,
    bgR: bg.r,
    bgG: bg.g,
    bgB: bg.b,
    primary,
    companion,
    selectedInkR: selectedInk.r,
    selectedInkG: selectedInk.g,
    selectedInkB: selectedInk.b,
    backdropDarkenR: backdropDarken.r,
    backdropDarkenG: backdropDarken.g,
    backdropDarkenB: backdropDarken.b,
    pulseColorR: pulseColor.r,
    pulseColorG: pulseColor.g,
    pulseColorB: pulseColor.b,
  };
}

/** Wrap delta to (-π, π] and return the target angle nearest to current. */
function nearestAngle(current: number, target: number): number {
  let delta = target - current;
  delta = ((delta + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return current + delta;
}

interface ThreadlineRigProps extends ThreadlineSceneProps {
  dark: boolean;
}

function ThreadlineRig(props: ThreadlineRigProps) {
  const {
    strands,
    selected,
    progressRef,
    levelRef,
    anchorsRef,
    reducedMotion,
    expanded,
  } = props;
  const { size } = useThree();
  const camera = useThree((s) => s.camera);

  const groupRef = useRef<THREE.Group>(null);
  const cameraZRef = useRef(BASE_Z);
  const rotationYRef = useRef(0);
  const prevProgressRef = useRef(progressRef.current);
  const selectedRef = useRef<string | null>(selected);
  const pulseStartRef = useRef<number | null>(null);

  const coreLineRef = useRef<THREE.Object3D | null>(null);
  const companionLineRef = useRef<THREE.Object3D | null>(null);
  const threadLineRefs = useRef<Map<string, THREE.Object3D | null>>(
    new Map(),
  );

  const totalThreads = DESKTOP_CW_COUNT + DESKTOP_CCW_COUNT;

  const names = useMemo(
    () => displayNamesFor(strands, selected, totalThreads),
    [strands, selected, totalThreads],
  );
  // Width quantized for the rebuild: during the view-switch CSS width
  // transition `size.width` changes every frame, and a full geometry rebuild
  // per frame would churn allocations. Radius follows the live width per
  // frame in useFrame instead; the baked geometry only needs it coarsely.
  const buildWidth = Math.round(size.width / 16) * 16;
  const build = useMemo(
    () => buildData(names, buildWidth, size.height, props.dark, expanded),
    [names, buildWidth, size.height, props.dark, expanded],
  );

  const focusRef = useRef(0);
  // View-switch bloom/collapse: fixed-duration tween toward `expanded`,
  // timed to match the AxisBand's 500 ms width transition. `from`/`start`
  // restart whenever the target flips.
  const expandRef = useRef(expanded ? 1 : 0);
  const expandTweenRef = useRef({
    from: expanded ? 1 : 0,
    target: expanded ? 1 : 0,
    start: 0,
  });
  const prevExpandRef = useRef(expandRef.current);

  // One-time material setup: transparent, no depth write, no per-frame shader
  // recompilation. Line2 materials expose opacity through uniforms.opacity.
  useEffect(() => {
    const setup = (obj: THREE.Object3D | null) => {
      const mat = (obj as any)?.material;
      if (!mat) return;
      mat.transparent = true;
      mat.depthWrite = false;
    };
    setup(coreLineRef.current);
    setup(companionLineRef.current);
    threadLineRefs.current.forEach(setup);
  }, [build]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    if (!build) return;

    const targetF = selected ? 1 : 0;
    const nextF = reducedMotion
      ? targetF
      : focusRef.current +
        (targetF - focusRef.current) * Math.min(1, dt * FOCUS_SMOOTH_SPEED);
    focusRef.current = nextF;

    // View-switch bloom/collapse tween (smoothstep over EXPAND_DURATION_MS).
    const expandTarget = expanded ? 1 : 0;
    const tween = expandTweenRef.current;
    if (tween.target !== expandTarget) {
      tween.from = expandRef.current;
      tween.target = expandTarget;
      tween.start = performance.now();
    }
    let expandE: number;
    if (reducedMotion) {
      expandE = expandTarget;
    } else {
      const k = Math.min(
        1,
        (performance.now() - tween.start) / EXPAND_DURATION_MS,
      );
      expandE = tween.from + (tween.target - tween.from) * (k * k * (3 - 2 * k));
    }
    const expandMoving = Math.abs(expandE - prevExpandRef.current) > 0.0004;
    prevExpandRef.current = expandE;
    expandRef.current = expandE;

    // Live (unquantized) radius: follows the band width every frame so the
    // weave swells smoothly while the CSS width transition runs.
    const radiusFactor = THREE.MathUtils.lerp(
      NARROW_RADIUS_FACTOR,
      DESKTOP_RADIUS_FACTOR,
      expandE,
    );
    const liveWorldWidth =
      (build.viewportWorldHeight *
        Math.max(size.width, VIRTUAL_MIN_BAND_PX)) /
      size.height;
    const R = (liveWorldWidth / 2) * radiusFactor;

    if (selected !== selectedRef.current) {
      selectedRef.current = selected;
      if (selected) {
        pulseStartRef.current = performance.now() / 1000;
      }
    }
    const pulseProgress =
      pulseStartRef.current != null
        ? Math.min(
            1,
            (performance.now() / 1000 - pulseStartRef.current) /
              PULSE_DURATION,
          )
        : 1;
    const pulseActiveGlobal = pulseProgress < 1;

    const level = levelRef.current ?? 1;
    const zoomMult = 1 + ZOOM_Z_MULTIPLIER * level;
    const focusMult = THREE.MathUtils.lerp(1, FOCUS_CAMERA_MULT, nextF);
    const targetZ = BASE_Z * zoomMult * focusMult;
    cameraZRef.current +=
      (targetZ - cameraZRef.current) *
      Math.min(1, dt * CAMERA_SMOOTH_SPEED);
    camera.position.z = cameraZRef.current;

    const lightAngle = reducedMotion
      ? 0
      : state.clock.elapsedTime * ((Math.PI * 2) / LIGHT_DRIFT_PERIOD);
    const lightDirX = -Math.cos(lightAngle);
    const lightDirZ = -Math.sin(lightAngle);
    const lightDirY = 0.35;
    const lightLen = Math.sqrt(
      lightDirX * lightDirX + lightDirY * lightDirY + lightDirZ * lightDirZ,
    );
    const lx = lightDirX / lightLen;
    const ly = lightDirY / lightLen;
    const lz = lightDirZ / lightLen;

    if (groupRef.current) {
      const progress = progressRef.current;
      const scrollVel =
        (progress - prevProgressRef.current) / Math.max(dt, 0.001);
      prevProgressRef.current = progress;

      const cosTarget = Math.max(
        -1,
        Math.min(
          1,
          ((SELECTED_OFFSET_FACTOR * 2) / radiusFactor) *
            (cameraZRef.current / BASE_Z),
        ),
      );
      const posTarget = Math.acos(cosTarget);
      const negTarget = -Math.acos(cosTarget);
      let targetAngle = posTarget;
      let minDelta = Math.abs(
        nearestAngle(rotationYRef.current, posTarget) -
          rotationYRef.current,
      );
      const negDelta = Math.abs(
        nearestAngle(rotationYRef.current, negTarget) -
          rotationYRef.current,
      );
      if (negDelta < minDelta) {
        targetAngle = negTarget;
        minDelta = negDelta;
      }

      if (reducedMotion) {
        rotationYRef.current = selected
          ? nearestAngle(rotationYRef.current, targetAngle)
          : 0;
      } else {
        rotationYRef.current +=
          dt * ROTATION_SPEED * (1 - nextF) +
          scrollVel * 0.0005 * (1 - nextF);
        rotationYRef.current +=
          (nearestAngle(rotationYRef.current, targetAngle) -
            rotationYRef.current) *
          Math.min(1, dt * ANGLE_EASE_SPEED * nextF);
      }
      groupRef.current.rotation.y = rotationYRef.current;

      const rawOffset =
        (progress - 0.5) *
        (build.columnHeight - build.viewportWorldHeight);
      const wrapped =
        ((rawOffset % build.turnPeriod) + build.turnPeriod) % build.turnPeriod;
      groupRef.current.position.y = wrapped - build.turnPeriod / 2;
    }

    const coreOpacity = THREE.MathUtils.lerp(0.8, 0.5, nextF);
    const coreMat = (coreLineRef.current as any)?.material;
    if (coreMat) {
      coreMat.opacity = coreOpacity;
      if (coreMat.uniforms?.opacity)
        coreMat.uniforms.opacity.value = coreOpacity;
    }
    const companionMat = (companionLineRef.current as any)?.material;
    if (companionMat) {
      const companionOpacity = coreOpacity * 0.55;
      companionMat.opacity = companionOpacity;
      if (companionMat.uniforms?.opacity)
        companionMat.uniforms.opacity.value = companionOpacity;
    }

    const needsPositions =
      (nextF > 0.001 && nextF < 0.999) ||
      anchorsRef.current.length > 0 ||
      expandMoving;

    const groupY = groupRef.current?.position.y ?? 0;
    // Pulse travels from NOW (bottom) upward: y is positive-up, so the
    // center starts below the viewport and climbs.
    const pulseCenterWorldY =
      (pulseProgress - 0.5) * build.viewportWorldHeight;
    const pulseWidthWorldY = build.viewportWorldHeight * PULSE_WIDTH_FACTOR;

    // Convergence anchors: screen fractions (0=top, 1=bottom of the shared
    // viewport) → world Y at the camera's z=0 plane. A point's world Y is
    // ys[i] + groupY, same mapping the pulse uses.
    const anchorFractions = anchorsRef.current;
    const anchorWorldYs: number[] = [];
    for (let i = 0; i < anchorFractions.length; i++) {
      anchorWorldYs.push(
        screenFractionToWorldY(
          anchorFractions[i],
          build.viewportWorldHeight,
        ),
      );
    }
    const convOpts = {
      depth: CONVERGENCE_DEPTH,
      sigma: build.viewportWorldHeight * CONVERGENCE_SIGMA_FACTOR,
    };

    build.threads.forEach((thread) => {
      const line = threadLineRefs.current.get(thread.name);
      if (!line) return;
      const isSelected = thread.name === selected;
      const pulseActive = isSelected && pulseActiveGlobal;

      if (line) {
        (line as any).renderOrder = isSelected ? 3 : 1;
      }
      const mat = (line as any).material;
      if (mat) {
        // Extra fibers only exist in the bloomed weave — they fade with the
        // expand factor while the surviving 12 hold their base opacity.
        const collapseFade = thread.extra ? expandE : 1;
        const targetOpacity =
          (pulseActive
            ? 1
            : THREE.MathUtils.lerp(
                thread.baseOpacity,
                isSelected ? 1 : 0.12,
                nextF,
              )) * collapseFade;
        mat.opacity = targetOpacity;
        if (mat.uniforms?.opacity) mat.uniforms.opacity.value = targetOpacity;
      }

      const geom = (line as any).geometry;
      if (!geom) return;
      const n = thread.ys.length;

      // Collapsed-phase offset: rotates each fiber between its collapsed and
      // open slot, so the weave visually unfolds out of the core as the
      // bundle blooms. Additive on thetaBase, so lighting stays consistent.
      const phaseDelta = (1 - expandE) * (thread.phaseNarrow - thread.phase);

      // Line2 geometry uses INTERLEAVED buffers (start/end share one array
      // with stride 6) — always write through setXYZ, never raw .array
      // indexing, and flag the backing buffer dirty.
      const markDirty = (attr: any) => {
        if (attr?.data) attr.data.needsUpdate = true;
        else if (attr) attr.needsUpdate = true;
      };

      const startPos = geom.attributes.instanceStart;
      const endPos = geom.attributes.instanceEnd;
      if (startPos && endPos && needsPositions) {
        for (let i = 0; i < n - 1; i++) {
          const theta0 = isSelected
            ? THREE.MathUtils.lerp(
                thread.thetaBase[i] + phaseDelta,
                0,
                nextF,
              )
            : thread.thetaBase[i] + phaseDelta;
          const theta1 = isSelected
            ? THREE.MathUtils.lerp(
                thread.thetaBase[i + 1] + phaseDelta,
                0,
                nextF,
              )
            : thread.thetaBase[i + 1] + phaseDelta;
          // Convergence: the helices pinch toward the core at row-start
          // anchors. The selected thread keeps its straightening animation
          // untouched so the focus transition never fights the envelope.
          const r0 = isSelected
            ? R
            : R *
              radiusEnvelopeAt(thread.ys[i] + groupY, anchorWorldYs, convOpts);
          const r1 = isSelected
            ? R
            : R *
              radiusEnvelopeAt(
                thread.ys[i + 1] + groupY,
                anchorWorldYs,
                convOpts,
              );
          startPos.setXYZ(i, r0 * Math.cos(theta0), thread.ys[i], r0 * Math.sin(theta0));
          endPos.setXYZ(
            i,
            r1 * Math.cos(theta1),
            thread.ys[i + 1],
            r1 * Math.sin(theta1),
          );
        }
        markDirty(startPos);
        markDirty(endPos);
      }

      const startCol = geom.attributes.instanceColorStart;
      const endCol = geom.attributes.instanceColorEnd;
      if (!startCol || !endCol) return;

      const bgR = build.bgR;
      const bgG = build.bgG;
      const bgB = build.bgB;
      const grayR = thread.grayR;
      const grayG = thread.grayG;
      const grayB = thread.grayB;
      const selR = build.selectedInkR;
      const selG = build.selectedInkG;
      const selB = build.selectedInkB;
      const darkR = build.backdropDarkenR;
      const darkG = build.backdropDarkenG;
      const darkB = build.backdropDarkenB;
      const pulseR = build.pulseColorR;
      const pulseG = build.pulseColorG;
      const pulseB = build.pulseColorB;

      // Per-POINT colors, computed once: point i supplies the start of
      // segment i and the end of segment i-1.
      for (let i = 0; i < n; i++) {
        const theta = isSelected
          ? THREE.MathUtils.lerp(thread.thetaBase[i] + phaseDelta, 0, nextF)
          : thread.thetaBase[i] + phaseDelta;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        const lit = AMBIENT + DIFFUSE * Math.max(0, cosT * lx + sinT * lz);
        const depthFactor = 0.2 + 0.8 * ((sinT + 1) / 2);
        const crossing = Math.exp(-CROSSING_SHARPNESS * Math.abs(cosT));
        const strength = Math.max(
          0,
          Math.min(1, lit * depthFactor * (1 - CROSSING_DARKEN * crossing)),
        );

        let r = bgR + (grayR - bgR) * strength;
        let g = bgG + (grayG - bgG) * strength;
        let b = bgB + (grayB - bgB) * strength;

        if (isSelected) {
          const baseR = bgR + (grayR - bgR) * 0.9;
          const baseG = bgG + (grayG - bgG) * 0.9;
          const baseB = bgB + (grayB - bgB) * 0.9;
          r = baseR + (selR - baseR) * nextF;
          g = baseG + (selG - baseG) * nextF;
          b = baseB + (selB - baseB) * nextF;
        } else {
          const fade = nextF * 0.75;
          r = r + (darkR - r) * fade;
          g = g + (darkG - g) * fade;
          b = b + (darkB - b) * fade;
        }

        if (pulseActive) {
          const worldY = thread.ys[i] + groupY;
          const envelope = Math.exp(
            -Math.pow((worldY - pulseCenterWorldY) / pulseWidthWorldY, 2),
          );
          r = r + (pulseR - r) * envelope;
          g = g + (pulseG - g) * envelope;
          b = b + (pulseB - b) * envelope;
        }

        if (i < n - 1) startCol.setXYZ(i, r, g, b);
        if (i > 0) endCol.setXYZ(i - 1, r, g, b);
      }
      markDirty(startCol);
      markDirty(endCol);
    });
  });

  if (!build) return null;

  return (
    <group ref={groupRef}>
      <Line
        ref={coreLineRef as any}
        points={build.corePoints}
        color={build.primary}
        lineWidth={1.5}
        transparent
        opacity={0.8}
        depthTest={false}
        renderOrder={2}
      />
      <Line
        ref={companionLineRef as any}
        points={build.companionPoints}
        color={build.companion}
        lineWidth={1}
        transparent
        opacity={0.56}
        depthTest={false}
        renderOrder={2}
      />
      {build.threads.map((thread) => (
        <Line
          key={thread.name}
          ref={(el) => {
            threadLineRefs.current.set(
              thread.name,
              el as THREE.Object3D | null,
            );
          }}
          points={thread.points}
          vertexColors={thread.colors}
          lineWidth={1}
          transparent
          opacity={thread.extra && !expanded ? 0 : thread.baseOpacity}
          renderOrder={1}
        />
      ))}
    </group>
  );
}

export default function ThreadlineScene(props: ThreadlineSceneProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, BASE_Z], fov: FOV }}
        gl={{ antialias: true, alpha: true }}
        onCreated={(state) => state.gl.setClearColor(0x000000, 0)}
        style={{ position: "absolute", inset: 0 }}
      >
        <ThreadlineRig {...props} dark={dark} />
      </Canvas>
    </div>
  );
}
