/**
 * Paper grain tile from a REAL PAPER SCAN (round 5, LIGHT-BAKED LOW-PASS) —
 * replaces the round-4 raw-luminance pipeline, whose dense high-frequency
 * speckle read as gravel and reportedly triggers trypophobia.
 *
 * Sources (both ambientCG Paper001, CC0, https://ambientcg.com/view?id=Paper001):
 *   assets/paper/paper001-color-1k.jpg        — 1024² colour scan
 *   assets/paper/paper001-displacement-1k.jpg — PBR displacement = heightfield
 *
 * Material-perception rationale: paper's readable cues live in LOW-frequency
 * formation cloud (fibres clumping into cloudy brightness variation) plus
 * GENTLE directional relief from a fixed light. High frequencies carry no
 * paper signal here — they only read as speckle — so this pipeline low-passes
 * everything and bakes Lambert lighting into the tile offline:
 *
 * Pipeline (all in a headless-Chromium canvas, no new dependencies):
 *   1. SEAMLESS   offset-by-half + centre-cross cross-fade, applied to BOTH
 *      the colour luminance and the heightfield with the identical mask, so
 *      the two layers stay pixel-registered.
 *   2. LOW-PASS   separable box blur (horizontal + vertical, --blur px,
 *      wrap-around indexing so the tileable field stays seamless) on BOTH
 *      layers. No high-frequency energy may reach the output.
 *   3. FORMATION  F = low-passed colour luminance, mean-normalized (F = v/mean).
 *   4. NORMALS    central differences on the low-passed heightfield × --bump,
 *      n = normalize(nx, ny, 1).
 *   5. LIGHTING   one distant light, azimuth upper-left, elevation ~45°:
 *      L = normalize(vec3(-0.5, 0.5, 0.7)) (y toward image top). NdotL clamped
 *      [0,1]; lightField = ambient + (1-ambient)*NdotL. High ambient — paper
 *      is soft, the unlit side must never clip to black.
 *   6. ALPHA      lit field L = F * lightField feeds the SAME anchored
 *      one-sided mapping as round 4: black ink where L dips below the p65
 *      anchor (light stock), white ink above p35 (dark stock). The tile rides
 *      in alpha over the sheet element's own bg-paper, plain source-over, so
 *      globals.css needs no change.
 *
 * The defaults below ARE the shipped asset's values — a bare regeneration
 * must reproduce the committed tile.
 *
 * Usage:
 *   node scripts/import-paper-scan.mjs                     # both polarities, defaults
 *   node scripts/import-paper-scan.mjs --bump 1.4 --blur 8 # retune relief/cloud
 */
import { chromium } from "@playwright/test";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SRC = "assets/paper/paper001-color-1k.jpg";
const DISP = "assets/paper/paper001-displacement-1k.jpg";
const OUT_DIR = "public";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}

/* The defaults below ARE the shipped asset's values — a bare regeneration
   must reproduce the committed tile. */
const SLOPE = arg("slope", 1.0);
const ANCHOR_PCT = arg("anchor-pct", 65); // ink-free percentile, see ALPHA below
const QUALITY = arg("quality", 88) / 100;
const BLEND = arg("blend", 96); // centre cross-fade half-width, px
const BLUR = arg("blur", 10); // separable box-blur radius, px — kills speckle
const BUMP = arg("bump", 12); // relief amplitude knob for the normal field
const AMBIENT = arg("ambient", 0.7); // floor of the baked light field

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><title>paper-scan</title>");

const srcB64 = readFileSync(SRC).toString("base64");
const dispB64 = readFileSync(DISP).toString("base64");

/**
 * Returns { light, dark } data URLs plus alpha statistics for each.
 * `ink`: 0 = black ink (light stock), 1 = white ink (dark stock).
 */
const result = await page.evaluate(
  ({ srcB64, dispB64, SLOPE, BLEND, QUALITY, ANCHOR_PCT, BLUR, BUMP, AMBIENT }) =>
    new Promise((resolve, reject) => {
      const load = (b64) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("source image failed to load"));
          im.src = `data:image/jpeg;base64,${b64}`;
        });

      Promise.all([load(srcB64), load(dispB64)])
        .then(([img, dispImg]) => {
          const W = img.width;
          const H = img.height;
          const c = document.createElement("canvas");
          c.width = W;
          c.height = H;
          const ctx = c.getContext("2d", { willReadFrequently: true });

          // Luminance fields — colour scan and displacement heightfield, both
          // drawn into the same W×H canvas so the layers stay registered even
          // if the source maps differ in pixel size.
          const luminanceOf = (im) => {
            ctx.drawImage(im, 0, 0, W, H);
            const d = ctx.getImageData(0, 0, W, H).data;
            const out = new Float32Array(W * H);
            for (let i = 0; i < W * H; i++) {
              out[i] =
                (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
            }
            return out;
          };
          const lum = luminanceOf(img);
          const height = luminanceOf(dispImg);

          // 1. SEAMLESS: out = lerp(offsetHalf, original, centreCrossMask).
          // The offset-half image's outer edges are adjacent interior pixels,
          // so the tile boundary is continuous; its wrap seams sit at the
          // centre cross, which the mask blends back to the seam-free original.
          // Applied to BOTH layers with the same mask — they must move together.
          const ramp = (d) => {
            // smoothstep 0→1 over |d| in [0, BLEND]
            const t = Math.min(1, Math.abs(d) / BLEND);
            return t * t * (3 - 2 * t);
          };
          const seamlessField = (f) => {
            const out = new Float32Array(W * H);
            for (let y = 0; y < H; y++) {
              const fy = ramp(y - H / 2);
              const yOff = (y + H / 2) % H;
              for (let x = 0; x < W; x++) {
                const fx = ramp(x - W / 2);
                const xOff = (x + W / 2) % W;
                const mask = Math.max(fx, fy); // 1 near centre cross, 0 at edges
                out[y * W + x] =
                  mask * f[y * W + x] + (1 - mask) * f[yOff * W + xOff];
              }
            }
            return out;
          };
          const lumS = seamlessField(lum);
          const heightS = seamlessField(height);

          // 2. LOW-PASS: separable box blur (horizontal then vertical) with
          // wrap-around indexing — the seamless field is periodic, and edge
          // clamping would reintroduce a seam. This is the speckle killer:
          // no high-frequency energy may reach the output.
          const boxBlur = (f, r) => {
            const tmp = new Float32Array(W * H);
            const out = new Float32Array(W * H);
            const w = 2 * r + 1;
            for (let y = 0; y < H; y++) {
              let acc = 0;
              for (let k = -r; k <= r; k++) acc += f[y * W + ((k + W) % W)];
              for (let x = 0; x < W; x++) {
                tmp[y * W + x] = acc / w;
                acc += f[y * W + ((x + r + 1) % W)] - f[y * W + ((x - r + W) % W)];
              }
            }
            for (let x = 0; x < W; x++) {
              let acc = 0;
              for (let k = -r; k <= r; k++) acc += tmp[((k + H) % H) * W + x];
              for (let y = 0; y < H; y++) {
                out[y * W + x] = acc / w;
                acc +=
                  tmp[((y + r + 1) % H) * W + x] - tmp[((y - r + H) % H) * W + x];
              }
            }
            return out;
          };
          const lumL = BLUR > 0 ? boxBlur(lumS, BLUR) : lumS;
          const heightL = BLUR > 0 ? boxBlur(heightS, BLUR) : heightS;

          // 3. FORMATION: mean-normalized low-passed colour luminance.
          let mean = 0;
          for (let i = 0; i < W * H; i++) mean += lumL[i];
          mean /= W * H;
          const F = new Float32Array(W * H);
          for (let i = 0; i < W * H; i++) F[i] = lumL[i] / mean;

          // 4. NORMALS: central differences on the low-passed heightfield,
          // scaled by BUMP; wrap-around indexing keeps the normal field
          // seamless. nx > 0 where the field rises toward the left,
          // ny > 0 where it rises toward the image top.
          // 5. LIGHTING: distant light from the upper left,
          //    L = normalize(vec3(-0.5, 0.5, 0.7)) — the +y is toward the
          //    image top, matching ny's sign. NdotL clamped [0,1];
          //    lightField floors at AMBIENT so the unlit side never clips
          //    to black. 6. LIT FIELD: L = F * lightField.
          const lLen = Math.hypot(-0.5, 0.5, 0.7);
          const lx = -0.5 / lLen;
          const ly = 0.5 / lLen;
          const lz = 0.7 / lLen;
          const lit = new Float32Array(W * H);
          for (let y = 0; y < H; y++) {
            const yu = ((y - 1 + H) % H) * W;
            const yd = ((y + 1) % H) * W;
            for (let x = 0; x < W; x++) {
              const xl = (x - 1 + W) % W;
              const xr = (x + 1) % W;
              const i = y * W + x;
              const nxa = (heightL[y * W + xl] - heightL[y * W + xr]) * BUMP;
              const nya = (heightL[yu + x] - heightL[yd + x]) * BUMP;
              const nLen = Math.hypot(nxa, nya, 1);
              const d = (nxa * lx + nya * ly + lz) / nLen;
              const lightField = AMBIENT + (1 - AMBIENT) * Math.max(0, d);
              lit[i] = F[i] * lightField;
            }
          }

          // 6. ALPHA, one-sided on the LIT field — same anchored mapping as
          // round 4. The anchor keeps most of the sheet ink-free (the stock
          // colour IS the paper); the low-passed lit field means the ink that
          // does land reads as soft formation cloud + directional relief,
          // never as speckle.
          const na = Float32Array.from(lit).sort();
          const anchorFor = (ink) =>
            // light: dips below p65 carry black ink; dark: rises above p35
            // carry white ink (the lit field's bright tail above p65 is too
            // short — a shared anchor left the dark tile nearly blank).
            na[Math.floor(na.length * ((ink === 0 ? ANCHOR_PCT : 100 - ANCHOR_PCT) / 100))];
          const out = {};
          for (const [name, ink] of [
            ["light", 0],
            ["dark", 1],
          ]) {
            const d = ctx.createImageData(W, H);
            let sum = 0;
            let amn = 255;
            let amx = 0;
            for (let i = 0; i < W * H; i++) {
              const n = lit[i];
              const anchorN = anchorFor(ink);
              const depth = ink === 0 ? anchorN - n : n - anchorN;
              const a = Math.round(Math.min(1, Math.max(0, depth) * SLOPE) * 255);
              d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = ink * 255;
              d.data[i * 4 + 3] = a;
              sum += a;
              if (a < amn) amn = a;
              if (a > amx) amx = a;
            }
            // High-frequency residue probe on the final alpha: mean absolute
            // adjacent gradient + gradient sign-change rate. Both must fall
            // as blur rises; sign-change rate near 0.5 means pixel-scale
            // noise dominates (speckle), low values mean smooth cloud.
            let gradSum = 0;
            let gradCnt = 0;
            let signChanges = 0;
            let signCnt = 0;
            for (let y = 1; y < H - 1; y += 2) {
              for (let x = 1; x < W - 1; x += 2) {
                const i = y * W + x;
                const gx = d.data[i * 4 + 3] - d.data[(i + 1) * 4 + 3];
                const gy = d.data[i * 4 + 3] - d.data[(i + W) * 4 + 3];
                gradSum += Math.abs(gx) + Math.abs(gy);
                gradCnt += 2;
                const a1 = d.data[(i - 1) * 4 + 3] - d.data[i * 4 + 3];
                const a2 = d.data[i * 4 + 3] - d.data[(i + 1) * 4 + 3];
                if ((a1 > 0 && a2 < 0) || (a1 < 0 && a2 > 0)) signChanges++;
                signCnt++;
              }
            }
            ctx.putImageData(d, 0, 0);
            out[name] = {
              webp: c.toDataURL("image/webp", QUALITY),
              png: c.toDataURL("image/png"),
              mean: sum / (W * H) / 255,
              min: amn / 255,
              max: amx / 255,
              pp: (amx - amn) / 255,
              meanAbsGrad: gradSum / gradCnt / 255,
              signChange: signChanges / signCnt,
            };
          }
          resolve({
            out,
            litRange: [lit[0], lit[W * H - 1]],
            anchors: [anchorFor(0), anchorFor(1)],
          });
        })
        .catch(reject);
    }),
  { srcB64, dispB64, SLOPE, BLEND, QUALITY, ANCHOR_PCT, BLUR, BUMP, AMBIENT },
);

mkdirSync(OUT_DIR, { recursive: true });
console.log(
  `sources ${SRC} + ${DISP}: lit anchors light/dark [${result.anchors.map((v) => v.toFixed(3)).join(", ")}]`,
);
for (const [name, r] of Object.entries(result.out)) {
  for (const ext of ["webp", "png"]) {
    const file = path.join(OUT_DIR, `paper-grain-${name}.${ext}`);
    writeFileSync(file, Buffer.from(r[ext].split(",")[1], "base64"));
    const bytes = statSync(file).size;
    console.log(
      `${file}: ${(bytes / 1024).toFixed(1)} KiB  alpha mean=${r.mean.toFixed(3)} p-p=${r.pp.toFixed(3)} range=[${r.min.toFixed(2)},${r.max.toFixed(2)}] hf grad=${r.meanAbsGrad.toFixed(4)} signchg=${r.signChange.toFixed(3)}`,
    );
  }
}

await browser.close();
console.log("done");
