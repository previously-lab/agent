"use client";

/**
 * AnchorHologram — the §13.1 anchor in holographic form, shared by both
 * mount points (every room's doorway wall, the lobby's east wall).
 *
 * WHAT IT IS. The room's anchor is a MINIATURE OF THE LEFT BAND'S BRAID:
 * one bright blue core line (the room's own slice of the timeline) with a
 * few quiet grey threads wound around it — one per strand passing through
 * the slice, one per newer slice of the corridor window — braided through
 * a single knot at eye height while the core climbs on above the walls.
 * The geometry is `anchor-hologram-geometry.ts`, which is `winding.ts`'s
 * coaxial model standing up in the room; this file only bakes it into
 * instanced tubes and keeps it alive.
 *
 * COLOUR IS THE BAND'S COLOUR, NOT THE ROOM'S (reader decision): the
 * core wears the brand blue #0066ff — the same ink the band's core wears
 * while it is the answer, and the card view's theme colour — and every
 * outer thread wears a neutral grey, like the band's resting strands.
 * Nothing here follows `recipe.palette.accent`, so the hologram reads
 * identically under every world skin.
 *
 * DETERMINISM (A6). The baked bytes are a pure function of (strands,
 * neighborSlots) — slice and door data, never the clock, never a seed.
 * The live motions are the rigid self-spin (`rotation.y = t ·
 * HOLO_SPIN_SPEED`, frozen under prefers-reduced-motion), the breath on
 * the core's gain, the scanline drift, the fog's travelling bands and
 * the fog's slow breathing — all pure functions of the clock, none
 * feeding back into the geometry. On a cylinder the rigid spin only
 * re-deals which seat faces the viewer, and the per-instance brightness
 * was baked in the cable's own frame, so the bundle turns as one
 * physical object (threadline-scene's group-spin discipline).
 *
 * THE OBJECT IS A COLUMN OF LIGHT, NOT A MACHINE (reader decision). The
 * threads keep an EQUAL radius along their whole length — thinning them
 * to hairs at the top was rejected — and dissipation is done entirely
 * with light: a baked brightness envelope (brightest at the knot,
 * falling to zero at both ends) means the lines stop glowing where the
 * column dissolves, they do not stop existing, and the bloom threshold
 * (1.0) turns the ramp into a glow ramp. Every line material — core,
 * bundle, halo — is ADDITIVE with depthWrite off (black adds nothing):
 * a segment whose baked brightness has fallen to 0 contributes zero
 * light, so the dissolve ends in nothing, never in a black tube. Each
 * thread is drawn twice — the hairline plus a fatter, dimmer HALO SHELL
 * reusing the same baked
 * points, a glow tube that softens the wire's edge from every angle —
 * and the whole bundle is wrapped in a soft-edged FOG: crossed additive
 * quads with a radial-gradient texture (brightest around the knot, zero
 * at both ends, no rim, no cap), wide enough to read as a volume the
 * braid floats inside. The fog is alive: faint bands travel slowly up
 * it and its intensity breathes, both frozen under
 * prefers-reduced-motion like the other motions. The CORE is the
 * exception that anchors the eye — crisp #0066ff, the brightest thing
 * in the object, full height, its top fade redrawn as light.
 *
 * LIGHT, REALLY (reader decision). A hologram that glows but lights
 * nothing reads as a decal, so a POINT LIGHT rides the cable — brand
 * blue, restrained, hard cutoff (the lamp's ×propScale² convention,
 * compensated from the caller's group scale each frame so miniature and
 * colossal rooms keep a proportional glow). The fog column and an
 * additive floor POOL spread at its foot carry the rest of the glow
 * (both the door-halo pattern: black-based texture + AdditiveBlending,
 * so no alpha ever gates coverage), and a very faint GHOST of the core
 * draws with depth testing off — through-wall presence at 5% strength,
 * an ambiance cue, never a quest marker.
 *
 * EVERYTHING ELSE IS THE OLD TERMINAL'S CONTRACT. Position and rotation
 * still come from `anchor.ts`'s resolver through the caller's group (the
 * footprint is smaller than the terminal's, so every cleared spot still
 * clears). Interaction is still the integrator's walk-up-and-Enter: the
 * proximity measure, `TERMINAL_DEPART.t0` stamp and the catalog jump all
 * live in game-canvas.tsx, untouched — this component only READS the
 * depart clock and swells, and keeps writing `TERMINAL_DEPART.intensity`
 * for the debug probes. Materials are owned here (created, animated,
 * disposed in this module); in rooms they mount under the room root, so
 * space.tsx's material capture carries them through the crossfade.
 *
 * THE LOBBY VARIANT rides the same component one size bigger (the
 * caller's group scale, LOBBY_TERMINAL_ANCHOR.scale): its strands are the
 * union of every strand threading the window, its neighbor count is the
 * window's slice count, and `dimmed` follows the corridor's dissolve
 * (light included).
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  TERMINAL_BREATH_PERIOD_S,
  TERMINAL_DEPART,
  TERMINAL_FLARE_GAIN,
  TERMINAL_FLARE_MS,
  TERMINAL_PLINTH,
  TERMINAL_SCAN_DRIFT,
} from "./anchor";
import { RADIAL_SEGMENTS } from "@/lib/timeline3d/tube";
import {
  HOLO_BOTTOM,
  HOLO_BUNDLE_GLOW,
  HOLO_CENTER_Y,
  HOLO_COLUMN_BAND_DEPTH,
  HOLO_COLUMN_BANDS,
  HOLO_CORE_RADIUS,
  HOLO_FOG_BAND_SPEED,
  HOLO_FOG_BREATH_AMOUNT,
  HOLO_FOG_BREATH_PERIOD_S,
  HOLO_FOG_CORE_LANE_GAIN,
  HOLO_FOG_CORE_LANE_TIGHTNESS,
  HOLO_FOG_DENSITY_MIN,
  HOLO_FOG_EDGE_CURVE,
  HOLO_FOG_GAIN,
  HOLO_FOG_WIDTH,
  HOLO_HALO_GAIN,
  HOLO_HALO_RADIUS_FACTOR,
  HOLO_NEIGHBOR_RADIUS,
  HOLO_SEGMENTS,
  HOLO_SPIN_SPEED,
  HOLO_STRAND_MAX,
  HOLO_STRAND_RADIUS,
  HOLO_TOP,
  holoCoreBake,
  holoThreadsFor,
  holoThreadBake,
  type HoloLineBake,
} from "./anchor-hologram-geometry";

/** The core's ink — the band's core blue (its `CORE_INK`), the card
 *  view's theme colour; the reader pinned it: core = #0066FF. */
const CORE_INK = "#0066ff";
/** The outer threads' ink — a neutral cool grey, the band's resting
 *  strand colour, light enough to read as a LINE in a dark room yet
 *  always dimmer than the core (which owns the only bloom). */
const BUNDLE_GREY = "#a8b3c4";
/** The core's gain range: base × breath just kisses the bloom threshold
 *  — a tight halo around the spine, never the fat ball that ate the
 *  braid; the real illumination is the point light's job. */
const CORE_GAIN_BASE = 0.85;
const CORE_GAIN_BREATH = 0.12;
/** The point light: brand blue, HALF the lamp's reach — a halo, not a
 *  work light. Intensity scales with the caller's group scale squared
 *  (the lamp's ×propScale² convention), distance linearly, so the glow
 *  stays proportional from miniature to colossal rooms. */
const LIGHT_INTENSITY = 3;
const LIGHT_DISTANCE = 6;
/** The ghost column's strength — 5% of the core's blue, visible only
 *  where geometry occludes the real line. */
const GHOST_GAIN = 0.05;
/** The scanline ripple count along the core's full height. */
const SCAN_LINES = 26;
/** How far the lobby's dissolve pulls the inks down (the corridor's
 *  rate, matching the old terminal's dim contract). */
const DIM_FADE = 0.88;

/**
 * prefers-reduced-motion, read straight off the media query: the spin
 * and the fog's band drift freeze (the shapes stay), the fog's breathing
 * settles to its base gain, and the core's breath and the light keep
 * breathing — luminance, not motion.
 */
const REDUCED_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The core's scanline texture, generated in code (no assets): a
 * brightness ripple along the cylinder's height — pixels, not material
 * alpha — that the frame loop drifts slowly upward. Opaque RGB.
 */
function createScanTexture(): THREE.CanvasTexture {
  const w = 2;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      const ripple = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * SCAN_LINES);
      const band = Math.round((0.82 + 0.18 * ripple) * 255);
      ctx.fillStyle = `rgb(${band},${band},${band})`;
      ctx.fillRect(0, y, w, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** The fog column's texture, generated in code (no assets): a radial
 *  cross-section (bright axis, zero at the quad's edges) times the
 *  travelling bands along the height. The radial profile is constant
 *  along v, so the frame loop's slow `offset.y` drift moves ONLY the
 *  bands — the soft edge never slides. The vertical falloff (bright at
 *  the knot, zero at both ends) is the QUADS' own UV taper in the JSX
 *  below, not part of this texture, so it cannot drift either. Black-
 *  based additive, opaque RGB; the cosine bands tile seamlessly. */
function createColumnTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1);
      const ripple = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * HOLO_COLUMN_BANDS);
      const band =
        1 - HOLO_COLUMN_BAND_DEPTH + HOLO_COLUMN_BAND_DEPTH * ripple;
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1);
        const r = Math.abs(2 * u - 1); // 0 at the axis → 1 at the quad's edges
        const hann = 0.5 + 0.5 * Math.cos(Math.PI * r);
        const body = Math.pow(hann, HOLO_FOG_EDGE_CURVE);
        const rc = Math.min(1, r * HOLO_FOG_CORE_LANE_TIGHTNESS);
        const lane =
          HOLO_FOG_CORE_LANE_GAIN * Math.pow(0.5 + 0.5 * Math.cos(Math.PI * rc), 3);
        const lum = Math.round(Math.min(1, (body + lane) * band) * 255);
        ctx.fillStyle = `rgb(${lum},${lum},${lum})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** The floor pool's radial falloff — same black-based additive pattern. */
function createPoolTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const half = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - half + 0.5, y - half + 0.5) / half;
        const band = Math.round(0.55 * Math.pow(Math.max(0, 1 - r), 2) * 255);
        ctx.fillStyle = `rgb(${band},${band},${band})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The direction a unit `CylinderGeometry` stands along before any
 *  rotation — orienting one onto a segment is one `setFromUnitVectors`. */
const CYLINDER_AXIS = new THREE.Vector3(0, 1, 0);
/** A segment with no direction collapses to zero size instead of taking
 *  an arbitrary axis. Shared, never written. */
const ZERO_SCALE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
/** Segment overlap. The tube geometry is OPEN-ENDED, so where two segments
 *  meet at an angle the outside of the joint opens a wedge — invisible on a
 *  nearly straight run, a row of notches through a tight coil. Stretching
 *  each segment 12% past its own ends buries the joint inside the next one;
 *  the bundle is hairlines, so the extra length is well under a millimetre
 *  of silhouette. */
const SEGMENT_OVERLAP = 1.12;
/** The fog quads' vertical UV taper: the quad geometry maps v 0..1 over
 *  HOLO_BOTTOM..HOLO_TOP, and the falloff windows below re-map those UVs
 *  so the texture eases to zero at both ends — brightest around the knot
 *  (the UVs straddle HOLO_CENTER_Y, so the knot samples the texture's
 *  peak), dissolving into the plinth below and into air above. Per-vertex
 *  (not in the texture), so the travelling bands can drift without the
 *  falloff ever moving. Distances are measured from the knot in metres,
 *  matching the threads' own envelope (HOLO_FADE_UP_SPAN is 0.8 up,
 *  HOLO_FADE_DOWN_SPAN 0.45 down) so the fog dissolves where the threads
 *  do. */
const FOG_TAPER_UP_SPAN = 0.8;
const FOG_TAPER_DOWN_SPAN = 0.5;
/** Taper curve exponent — same shape family as the threads' envelope: a
 *  smooth, bowed decay with no hard line anywhere. */
const FOG_TAPER_CURVE = 1.6;

/** Bake one line into an InstancedMesh of unit cylinders — one instance
 *  per segment, placed and inked exactly as the band's frame loop
 *  does, but ONCE: the matrices never change after this call. Every
 *  line is an EQUAL-radius tube along its whole length (the reader
 *  rejected thinning the ends to hairs): dissipation is the bake's
 *  brightness envelope, not width. All line materials are additive
 *  (see the component), so a segment whose brightness has fallen to 0
 *  adds nothing — there is no dark tube to hide, open-ended rim or
 *  not. */
function buildLineMesh(
  bake: HoloLineBake,
  radius: number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, HOLO_SEGMENTS);
  const dir = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mid = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const p = bake.points;
  for (let i = 0; i < HOLO_SEGMENTS; i++) {
    const ax = p[i * 3];
    const ay = p[i * 3 + 1];
    const az = p[i * 3 + 2];
    const bx = p[i * 3 + 3];
    const by = p[i * 3 + 4];
    const bz = p[i * 3 + 5];
    dir.set(bx - ax, by - ay, bz - az);
    const length = dir.length();
    if (length < 1e-6) {
      mesh.setMatrixAt(i, ZERO_SCALE_MATRIX);
      continue;
    }
    dir.divideScalar(length);
    quat.setFromUnitVectors(CYLINDER_AXIS, dir);
    mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    scale.set(radius, length * SEGMENT_OVERLAP, radius);
    mesh.setMatrixAt(i, matrix.compose(mid, quat, scale));
    // Every line seeds GREY instance colours (the core's array carries
    // its top-fade scalars, the threads their envelope-folded grey): a
    // scalar only scales the material colour — the band's warning was
    // against seeding colour instance colours, which square the ink.
    mesh.setColorAt(i, color.setScalar(bake.brightness[i]));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Instance matrices place the unit cylinder nowhere near the origin;
  // the default frustum test would cull the whole line.
  mesh.frustumCulled = false;
  if (bake.kind === "core") {
    // The spine stays legible through the bundle, as in the band.
    mesh.renderOrder = 2;
  }
  return mesh;
}

/** Bake one thread's SOFT EDGE: the SAME polyline re-drawn as a single
 *  fat, dim shell (every segment at HOLO_HALO_RADIUS_FACTOR × the
 *  thread's radius, inked at HOLO_HALO_GAIN × the thread's own baked
 *  brightness) — a glow tube around the wire that reads as scattered
 *  light from every viewing angle. The shell reuses the bake's points
 *  byte-for-byte, so it dissolves where the thread dissolves and never
 *  leaves the cable's footprint. Additive with no depth write: it
 *  hazes whatever lies behind a thread but never occludes. */
function buildHaloShell(
  bake: HoloLineBake,
  radius: number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, HOLO_SEGMENTS);
  const dir = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mid = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const shellRadius = radius * HOLO_HALO_RADIUS_FACTOR;
  const p = bake.points;
  for (let i = 0; i < HOLO_SEGMENTS; i++) {
    const ax = p[i * 3];
    const ay = p[i * 3 + 1];
    const az = p[i * 3 + 2];
    const bx = p[i * 3 + 3];
    const by = p[i * 3 + 4];
    const bz = p[i * 3 + 5];
    dir.set(bx - ax, by - ay, bz - az);
    const length = dir.length();
    if (length < 1e-6) {
      mesh.setMatrixAt(i, ZERO_SCALE_MATRIX);
      continue;
    }
    dir.divideScalar(length);
    quat.setFromUnitVectors(CYLINDER_AXIS, dir);
    mid.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    scale.set(shellRadius, length * SEGMENT_OVERLAP, shellRadius);
    mesh.setMatrixAt(i, matrix.compose(mid, quat, scale));
    mesh.setColorAt(i, color.setScalar(bake.brightness[i] * HOLO_HALO_GAIN));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** The fog's ONE quad: a vertical plane whose UVs are re-mapped so the
 *  texture's peak is sampled at the knot and zero at both ends (the
 *  vertical dissolve), and whose vertices are pulled out to those same
 *  shaped heights, so the quad's silhouette tapers to an edge where the
 *  glow ends — no cap, no rim, no visible boundary of any kind. Per-
 *  vertex (not in the texture): the bands drift along v freely while
 *  the falloff stays nailed to the knot. Three copies, crossed at 60°,
 *  make the volume read from every viewing angle. */
function buildFogQuadGeometry(): THREE.BufferGeometry {
  const height = HOLO_TOP - HOLO_BOTTOM;
  const geometry = new THREE.PlaneGeometry(HOLO_FOG_WIDTH, height, 1, 64);
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const v = uv.getY(i); // 0 at the quad's bottom → 1 at its top
    const y = HOLO_BOTTOM + v * height;
    const d = y - HOLO_CENTER_Y;
    const span = d >= 0 ? FOG_TAPER_UP_SPAN : FOG_TAPER_DOWN_SPAN;
    const t = Math.min(1, Math.abs(d) / span);
    const shaped = Math.pow(1 - t * t * (3 - 2 * t), FOG_TAPER_CURVE);
    uv.setY(i, shaped);
    pos.setY(i, (shaped - 0.5) * height);
  }
  uv.needsUpdate = true;
  pos.needsUpdate = true;
  return geometry;
}

export function AnchorHologram({
  dimmed = false,
  strands = [],
  neighborSlots = 0,
}: {
  /** Lobby-only: lerp down with the corridor's dissolve (light
   *  included). */
  dimmed?: boolean;
  /** The strands passing through this slice (the room-door data lane) —
   *  one braid thread each. */
  strands?: readonly string[];
  /** How many newer slices this room's window provably holds — one
   *  context thread each. */
  neighborSlots?: number;
}): JSX.Element {
  const coreInk = useMemo(() => new THREE.Color(CORE_INK), []);
  const greyInk = useMemo(() => new THREE.Color(BUNDLE_GREY), []);

  const unitCylinder = useMemo(
    () => new THREE.CylinderGeometry(1, 1, 1, RADIAL_SEGMENTS, 1, true),
    [],
  );
  const scanTexture = useMemo(() => createScanTexture(), []);
  const columnTexture = useMemo(() => createColumnTexture(), []);
  const poolTexture = useMemo(() => createPoolTexture(), []);
  // One tapered quad, shared by the three crossed copies of the fog.
  const fogGeometry = useMemo(() => buildFogQuadGeometry(), []);
  // The CORE is additive like everything else (black adds nothing), so its
  // faded tip contributes zero light instead of a black rod. It stays the
  // crispest element for three reasons: its material colour is refreshed
  // every frame at the highest gain in the object (CORE_GAIN_BASE × the
  // scan texture — full blue, never the threads' dimmed grey), its
  // full-radius tube never thins, and renderOrder 2 draws it last, over
  // the bundle and the fog.
  const coreMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        map: scanTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [scanTexture],
  );
  // The threads' hairlines — additive with no depth write: a segment
  // whose baked brightness is 0 adds nothing, so the dissolve ends in
  // nothing instead of the black tube an opaque zeroed instance colour
  // rendered. Additive also means the bundle SUMS on screen, which is
  // why HOLO_BUNDLE_GLOW is tuned for the stack, not the single wire.
  const bundleMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: BUNDLE_GREY,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  // The halo shells ride the same grey as the threads (their instance
  // colours already carry HOLO_HALO_GAIN), additive with no depth write:
  // a haze in front of whatever the thread occludes, never an occluder
  // itself.
  const haloMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: BUNDLE_GREY,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  const baseMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: TERMINAL_PLINTH,
        roughness: 0.9,
        metalness: 0,
        flatShading: true,
      }),
    [],
  );
  // The light column, floor pool and ghost all use the door-halo glow
  // pattern: a black-based texture + AdditiveBlending, so coverage is
  // never gated by alpha (black adds nothing). The scene alpha budget
  // stays untouched.
  const columnMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        map: columnTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [columnTexture],
  );
  const poolMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        map: poolTexture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [poolTexture],
  );
  const ghostMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: CORE_INK,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );

  // The braid, baked once for this room's data. The thread set is a pure
  // function of (strands, neighborSlots); either changing re-bakes, but
  // the integrator freezes the door data per mount, so in practice this
  // is mount-only.
  // Separator for the thread key — unit separator via fromCharCode so it is never an invisible source byte (a bare concat collides ["a","bc"] === ["ab","c"]).
  const SET_KEY_SEP = String.fromCharCode(1);
  const threadKey = strands.join(SET_KEY_SEP) + SET_KEY_SEP + neighborSlots;
  const phase = useMemo(() => phaseFor(threadKey), [threadKey]);
  const lines = useMemo(() => {
    const bakes: { bake: HoloLineBake; radius: number }[] = [
      { bake: holoCoreBake(), radius: HOLO_CORE_RADIUS },
      ...holoThreadsFor(strands, neighborSlots).map((thread) => ({
        bake: holoThreadBake(thread),
        radius:
          thread.kind === "strand"
            ? HOLO_STRAND_RADIUS
            : HOLO_NEIGHBOR_RADIUS,
      })),
    ];
    // Every thread draws twice: the hairline and its halo shell (same
    // baked points, fatter and dimmer). The core draws once — it is the
    // crisp landmark and keeps its own bloom.
    return bakes.flatMap(({ bake, radius }) => {
      const line = buildLineMesh(
        bake,
        radius,
        unitCylinder,
        bake.kind === "core" ? coreMaterial : bundleMaterial,
      );
      if (bake.kind === "core") return [line];
      return [line, buildHaloShell(bake, radius, unitCylinder, haloMaterial)];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey, unitCylinder, coreMaterial, bundleMaterial, haloMaterial]);
  useEffect(
    () => () => {
      for (const line of lines) line.dispose();
    },
    [lines],
  );
  useEffect(
    () => () => {
      unitCylinder.dispose();
      scanTexture.dispose();
      columnTexture.dispose();
      poolTexture.dispose();
      fogGeometry.dispose();
      coreMaterial.dispose();
      bundleMaterial.dispose();
      haloMaterial.dispose();
      baseMaterial.dispose();
      columnMaterial.dispose();
      poolMaterial.dispose();
      ghostMaterial.dispose();
    },
    [
      unitCylinder,
      scanTexture,
      columnTexture,
      poolTexture,
      fogGeometry,
      coreMaterial,
      bundleMaterial,
      haloMaterial,
      baseMaterial,
      columnMaterial,
      poolMaterial,
      ghostMaterial,
    ],
  );

  const spinRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const dimKRef = useRef(0);
  // Scratch — the frame loop reuses these, never allocates.
  const worldScale = useRef(new THREE.Vector3());
  const coreColor = useRef(new THREE.Color());

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    // The one live GEOMETRIC motion: a rigid spin of the whole cable
    // (and its fog, riding the same group). Frozen under
    // prefers-reduced-motion — the shape stays, the turning doesn't.
    if (spinRef.current && !REDUCED_MOTION) {
      spinRef.current.rotation.y = t * HOLO_SPIN_SPEED;
    }

    // The breath + the departure flare (the §13.2 屏幕亮起 beat, kept in
    // the game world): gain only, geometry untouched.
    const k = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / TERMINAL_BREATH_PERIOD_S + phase);
    let gain = CORE_GAIN_BASE + CORE_GAIN_BREATH * k;
    const depart = TERMINAL_DEPART.t0;
    if (depart >= 0) {
      const f = Math.min(1, (performance.now() - depart) / TERMINAL_FLARE_MS);
      gain *= 1 + TERMINAL_FLARE_GAIN * f * f;
    }
    TERMINAL_DEPART.intensity = gain;

    // Dim (lobby): follow the corridor's dissolve rate (≈6/s lerp).
    const dimK = (dimKRef.current +=
      (1 - Math.exp(-6 * Math.min(delta, 0.05))) * ((dimmed ? 1 : 0) - dimKRef.current));
    const dim = 1 - DIM_FADE * dimK;

    coreColor.current.copy(coreInk).multiplyScalar(gain * dim);
    coreMaterial.color.copy(coreColor.current);
    // The fog: a slow breath of its whole intensity (frozen under
    // prefers-reduced-motion — luminance breathing is still motion), and
    // a density that follows the DATA — a solitary slice is a thin dim
    // wisp, a busy one a full column. Never below HOLO_FOG_DENSITY_MIN.
    let fogGain = HOLO_FOG_GAIN;
    if (!REDUCED_MOTION) {
      const kf =
        0.5 +
        0.5 * Math.sin((t * Math.PI * 2) / HOLO_FOG_BREATH_PERIOD_S + phase);
      fogGain *= 1 - HOLO_FOG_BREATH_AMOUNT + HOLO_FOG_BREATH_AMOUNT * kf;
    }
    const strandK =
      Math.min(HOLO_STRAND_MAX, Math.max(0, strands.length)) / HOLO_STRAND_MAX;
    const densityK = HOLO_FOG_DENSITY_MIN + (1 - HOLO_FOG_DENSITY_MIN) * strandK;
    columnMaterial.color.copy(coreInk).multiplyScalar(fogGain * densityK * dim);
    poolMaterial.color.copy(coreInk).multiplyScalar(0.9 * dim);
    ghostMaterial.color.copy(coreInk).multiplyScalar(GHOST_GAIN * dim);
    bundleMaterial.color.copy(greyInk).multiplyScalar(HOLO_BUNDLE_GLOW * dim);
    // The shells track the bundle's gain so the soft edge never outlives
    // the thread it belongs to.
    haloMaterial.color.copy(greyInk).multiplyScalar(HOLO_BUNDLE_GLOW * dim);

    // The point light rides the caller's group scale (the lamp's
    // ×propScale² convention): miniature rooms get a dollhouse glow,
    // colossal rooms a flood.
    const light = lightRef.current;
    if (light) {
      const s = spinRef.current
        ? spinRef.current.getWorldScale(worldScale.current).x
        : 1;
      light.intensity = LIGHT_INTENSITY * s * s * dim;
      light.distance = LIGHT_DISTANCE * s;
    }

    // The scanlines drift barely perceptibly upward.
    scanTexture.offset.y = (t * TERMINAL_SCAN_DRIFT) % 1;
    // …and the fog's bands travel up it even slower (HOLO_FOG_BAND_SPEED
    // is a texture height per ~50 s). The radial cross-section is
    // constant along v, so only the bands move; the quads' own UV taper
    // keeps the falloff nailed to the knot.
    columnTexture.offset.y = (t * HOLO_FOG_BAND_SPEED) % 1;
  });

  return (
    <group>
      {/* The emitter: a slim dark disc where the cable rises from — the
          one solid, in the hotel's dark-trim register; the floor pool
          doubles as its glow. */}
      <mesh position={[0, 0.022, 0]} castShadow receiveShadow material={baseMaterial}>
        <cylinderGeometry args={[0.16, 0.18, 0.044, 24]} />
      </mesh>

      {/* The point light — brand blue, restrained, hard cutoff. */}
      <pointLight
        ref={lightRef}
        color={CORE_INK}
        position={[0, 1.4, 0]}
        decay={2}
      />

      {/* The through-wall ghost of the core — 5% blue, depth testing
          off, an ambiance cue where masonry blocks the real line. */}
      <mesh
        position={[0, (HOLO_BOTTOM + HOLO_TOP) / 2, 0]}
        material={ghostMaterial}
        renderOrder={3}
      >
        <cylinderGeometry args={[0.02, 0.02, HOLO_TOP - HOLO_BOTTOM, 8, 1, true]} />
      </mesh>

      {/* The cable and its weather, baked and spun rigidly: the core +
          bundle + their halo shells, the crossed fog quads, and the
          floor pool riding the same spin so the glow sweeps with the
          braid. The fog quads are depth-tested like the old column, so
          walls still occlude them (the ghost above carries the blocked
          case). */}
      <group ref={spinRef}>
        {lines.map((line, i) => (
          <primitive key={i} object={line} />
        ))}
        {[0, 1, 2].map((i) => (
          <mesh
            key={`fog-${i}`}
            position={[0, (HOLO_BOTTOM + HOLO_TOP) / 2, 0]}
            rotation={[0, (i * Math.PI) / 3, 0]}
            geometry={fogGeometry}
            material={columnMaterial}
            renderOrder={1}
          />
        ))}
        {/* The floor pool — additive blue spreading from the base, the
            "you can find it in the dark" cue. */}
        <mesh
          position={[0, 0.032, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          material={poolMaterial}
          renderOrder={1}
        >
          <planeGeometry args={[1.1, 1.1]} />
        </mesh>
      </group>

    </group>
  );
}

/** Deterministic per-data breath phase: two rooms' holograms never
 *  breathe in lockstep on the rare frames two are mounted at once. */
function phaseFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1000) * Math.PI * 2;
}
