/**
 * Pod placement probe — the companion pod's geometry, measured and asserted.
 *
 * WHY THIS EXISTS. The pod is a FIXED button on the right edge, and its whole
 * job is to stay out of every other control's way: JumpControls' stack holds
 * the bottom-right corner, the composer pill holds the bottom-centre, the
 * narration panel grows upward out of the button itself, and a phone adds a
 * safe-area at the foot. The offset (220px + safe-area, see
 * companion-pod.tsx) was picked from those constraints and is VERIFIED here,
 * at the two viewports that matter — 1440×900 and 390×844. If any measured
 * rect touches another control's rect, the probe fails (exit 1).
 *
 * The probe also drives the pod through one mocked narration (Playwright
 * intercepts POST /api/companion and streams text/plain) to assert the panel
 * half of the contract: it grows UPWARD from the button, stays inside the
 * viewport, scrolls when the prose is long (chrome row never scrolls away),
 * the button lights while speaking, the toggle is non-destructive, and the ✕
 * dismisses into a replayable "latest".
 *
 * The pod hides when the brain is bridge (the e2e suite's mode), so this
 * probe boots its own dev server in client mode WITHOUT the bridge against
 * throwaway temp dirs — never the developer's ~/.previously:
 *
 *   node scripts/probe-pod.mjs                # boot, assert, exit 0/1
 *   node scripts/probe-pod.mjs --base URL     # assert against a live server
 *
 * NOTE: from Git Bash (MSYS) a leading-slash flag gets path-converted; the
 * flags above are fine, but URLs in --base may need MSYS_NO_PATHCONV=1.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3210;
const baseArg = process.argv.indexOf("--base");
const externalBase =
  baseArg >= 0 ? process.argv[baseArg + 1] : process.env.POD_PROBE_BASE;
const BASE = externalBase ?? `http://localhost:${PORT}`;
const PROBE_ROOT = path.join(tmpdir(), "previously-probe");
const HOME_DIR = path.join(PROBE_ROOT, "home");
const MEMORY_ROOT = path.join(PROBE_ROOT, "memory");
const SERVER_LOG = path.join(PROBE_ROOT, "server.log");

/** Long enough that the capped panel must scroll to show it all. */
const NARRATION = Array.from(
  { length: 24 },
  (_, i) =>
    `Paragraph ${i + 1}. The morning began quietly, the way these mornings do, with the field still settling into its newest slices. Previously walked the reader through what happened, slowly, the way you would retell a walk you loved.`,
).join("\n\n");

// ── Minimal seed (mirrors tests/e2e/memory-fixture.ts's on-disk contract) ──

function sliceFileDir(id) {
  const [y, m, d, hm] = id.split("-");
  return path.join(MEMORY_ROOT, "episodic", "slices", y, m, d, hm, "timeline");
}

function serializeSlice({ id, start, end, focus, summary, userText, agentText }) {
  const q = (s) => JSON.stringify(s);
  return `---
slice_id: ${q(id)}
focus: ${q(focus)}
status: "closed"
start: ${q(start)}
end: ${q(end)}
timezone: "UTC"
summary: ${q(summary)}
open_loops: []
decisions: []
tags: []
related_slices: []
loops: []
closed_by: "idle_gap"
---

## Turn t1 — ${start} (user)

${userText}

## Turn t2 — ${start} (agent)

${agentText}
`;
}

async function seedMemory() {
  const slices = [
    {
      id: "2026-07-27-0900",
      start: "2026-07-27T09:00:00.000Z",
      end: "2026-07-27T09:20:00.000Z",
      focus: "Probe slice one",
      summary: "The first of two probe slices.",
      userText: "PROBE one user question",
      agentText: "PROBE one agent answer",
    },
    {
      id: "2026-07-28-0658",
      start: "2026-07-28T06:58:00.000Z",
      end: "2026-07-28T07:18:00.000Z",
      focus: "Probe slice two",
      summary: "The second of two probe slices.",
      userText: "PROBE two user question",
      agentText: "PROBE two agent answer",
    },
  ];
  for (const s of slices) {
    const dir = sliceFileDir(s.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "core.md"), serializeSlice(s), "utf8");
  }
  const catalog = {
    _schema: 1,
    updated_at: new Date().toISOString(),
    slice_count: slices.length,
    needs_marking: 0,
    slices: slices.map((s) => ({
      id: s.id,
      date: s.id.slice(0, 10),
      start: s.start,
      end: s.end,
      turn_count: 2,
      status: "closed",
      focus: s.focus,
      summary: s.summary,
      tags: [],
      open_loops: [],
      decisions: [],
      strands: [],
      needs_marking: false,
      closed_by: "idle_gap",
    })),
  };
  const timelineDir = path.join(MEMORY_ROOT, "episodic", "timeline");
  await mkdir(timelineDir, { recursive: true });
  await writeFile(
    path.join(timelineDir, "index.json"),
    JSON.stringify(catalog, null, 2),
    "utf8",
  );
}

// ── Measurement ─────────────────────────────────────────────────────────────

/** Runs in the page: every rect that matters, plus pairwise intersections. */
const MEASURE = `(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const o = (n) => Math.round(n * 10) / 10;
    return { top: o(r.top), right: o(r.right), bottom: o(r.bottom), left: o(r.left), width: o(r.width), height: o(r.height) };
  };
  const overlap = (a, b) =>
    !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const pod = document.querySelector("[data-companion-pod]");
  const panel = document.querySelector("[data-companion-pod-panel]");
  const jumps = [...document.querySelectorAll("[data-jump]")].map(box);
  const composer = box(document.querySelector("[data-composer]"));
  const podBox = box(pod);
  const panelBox = box(panel);
  const prose = panel
    ? [...panel.querySelectorAll("div")].find(
        (d) => getComputedStyle(d).overflowY === "auto",
      )
    : null;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pod: podBox,
    podActive: pod?.getAttribute("data-active") ?? null,
    panel: panelBox,
    jumps,
    composer,
    overlaps: {
      podJumps: jumps.some((j) => overlap(podBox, j)),
      podComposer: overlap(podBox, composer),
      panelJumps: jumps.some((j) => overlap(panelBox, j)),
      panelPod: overlap(panelBox, podBox),
    },
    proseScroll: prose
      ? { scrollable: prose.scrollHeight > prose.clientHeight + 1 }
      : null,
  };
})()`;

// ── Assertions ──────────────────────────────────────────────────────────────

let failures = 0;

function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function checkRestGeometry(m, vpName) {
  const { viewport: v, pod, jumps, composer, overlaps } = m;
  // Right-edge seat: 12px inset on a phone, 20px at ≥640px — the jump
  // cluster's own offsets, so the pod reads as one family with it.
  const wantRight = v.w < 640 ? 12 : 20;
  check(
    `${vpName}: pod sits at the right edge`,
    pod && Math.abs(v.w - pod.right - wantRight) <= 3,
    pod ? `right inset ${Math.round(v.w - pod.right)}px, want ${wantRight}px` : "no pod",
  );
  check(
    `${vpName}: pod fully inside the viewport`,
    pod && pod.top >= 0 && pod.left >= 0 && pod.bottom <= v.h && pod.right <= v.w,
    pod ? `pod bottom ${pod.bottom} of ${v.h}` : "no pod",
  );
  check(`${vpName}: pod clears JumpControls`, !overlaps.podJumps,
    jumps[0] ? `jump stack top at ${jumps[0].top}, pod bottom ${pod?.bottom}` : "no jumps");
  check(`${vpName}: pod clears the composer`, !overlaps.podComposer,
    composer ? `composer top ${composer.top}, pod bottom ${pod?.bottom}` : "no composer");
  // The measured fact the 220px offset is built on: the jump stack's top
  // edge, in px above the viewport foot. Printed every run so a drift in
  // JumpControls' own styling is visible here first.
  if (jumps[0] && pod) {
    // jumps[0] is the upper button — the stack's leading edge.
    const stackTopFromFoot = v.h - jumps[0].top;
    const podBottomFromFoot = v.h - pod.bottom;
    console.log(
      `       ${vpName}: jump stack top ${stackTopFromFoot}px above the foot, pod bottom ${podBottomFromFoot}px — margin ${Math.round(podBottomFromFoot - stackTopFromFoot)}px`,
    );
  }
}

function checkPanelGeometry(m, vpName) {
  const { viewport: v, pod, panel, overlaps } = m;
  check(`${vpName}: panel grows upward from the button`, !!panel && panel.bottom <= pod.top - 4,
    panel ? `panel bottom ${panel.bottom}, button top ${pod.top}` : "no panel");
  check(`${vpName}: panel inside the viewport`,
    !!panel && panel.top >= 0 && panel.left >= 0 && panel.right <= v.w,
    panel ? `panel top ${panel.top}, left ${panel.left}, right ${panel.right} of ${v.w}` : "no panel");
  check(`${vpName}: panel clears JumpControls`, !overlaps.panelJumps);
  check(`${vpName}: panel does not cover the button`, !overlaps.panelPod);
  // Scroll is asserted after completion below — mid-flight the body is still
  // the one-line thinking reserve, there is nothing to scroll yet.
}

// ── Server boot (unless --base points at a live one) ────────────────────────

let server = null;
let serverLog = "";

async function bootServer() {
  await rm(PROBE_ROOT, { recursive: true, force: true });
  await mkdir(HOME_DIR, { recursive: true });
  await seedMemory();
  const gen = spawn(process.execPath, ["scripts/generate-identity.mjs"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => gen.on("exit", resolve));
  server = spawn("pnpm", ["exec", "next", "dev", "--turbopack", "--port", String(PORT)], {
    shell: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PREVIOUSLY_MODE: "client",
      PREVIOUSLY_HOME: HOME_DIR,
      MEMORY_ROOT,
      STORAGE: "local",
    },
  });
  server.stdout?.on("data", (d) => (serverLog += d));
  server.stderr?.on("data", (d) => (serverLog += d));
  server.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\n[probe-pod] dev server exited early (code ${code}). Last log:\n${serverLog.slice(-2000)}`);
      process.exit(1);
    }
  });
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${BASE}/en`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (i > 180) {
      console.error(`\n[probe-pod] dev server did not come up. Last log:\n${serverLog.slice(-2000)}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function shutdownServer() {
  if (!server || server.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { shell: true });
  } else {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}

// ── Scenario ────────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];

async function runViewport(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  // The mocked mouth: a SLOW, long narration — slow enough that the speaking
  // state is observable (the probe asserts the button lights mid-flight),
  // long enough that the capped panel must scroll.
  await page.route("**/api/companion", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: NARRATION,
    });
  });

  // REST GEOMETRY, both rungs: conversation (full composer) and slice
  // (compact pill + the narrate entry).
  for (const route of ["/en", "/en?z=slice"]) {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2500);
    const m = await page.evaluate(MEASURE);
    checkRestGeometry(m, `${vp.name} ${route}`);
  }

  // THE NARRATION FLOW, on the slice rung. The field portals every card into
  // the DOM and scrolls the pile virtually, so most narrate buttons sit
  // outside the viewport; the buttons are also opacity-0 until their card
  // hovers, which Playwright still counts as "visible". Find the one button
  // that is genuinely on screen and click it in-page (bubbling, so React's
  // delegated listener and the card's stopPropagation both see it).
  await page.goto(`${BASE}/en?z=slice`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2500);
  const clicked = await page.evaluate(() => {
    const btns = [
      ...document.querySelectorAll('button[aria-label="Narrate this slice"]'),
    ];
    const onScreen = btns.find((b) => {
      const r = b.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.top >= 0 &&
        r.bottom <= window.innerHeight &&
        r.left >= 0 &&
        r.right <= window.innerWidth
      );
    });
    if (!onScreen) return false;
    onScreen.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  if (!clicked) throw new Error("no on-screen narrate button at ?z=slice");

  // Speaking state + panel geometry while the stream is live.
  await page.waitForSelector("[data-companion-pod-panel]", { timeout: 15_000 });
  await page.waitForTimeout(500); // entrance animation settles
  let m = await page.evaluate(MEASURE);
  check(`${vp.name}: button lights while speaking`, m.podActive === "true",
    `data-active=${m.podActive}`);
  checkPanelGeometry(m, vp.name);

  // The stream completes; the full text lands.
  await page.waitForFunction(
    () => document.querySelector("[data-companion-pod-panel]")?.textContent?.includes("Paragraph 24."),
    { timeout: 15_000 },
  );
  m = await page.evaluate(MEASURE);
  check(`${vp.name}: long narration scrolls after completion`, m.proseScroll?.scrollable === true);

  // Toggle is non-destructive: close, reopen, the live narration is still there.
  await page.click("[data-companion-pod]");
  await page.waitForSelector("[data-companion-pod-panel]", { state: "detached", timeout: 10_000 });
  await page.click("[data-companion-pod]");
  await page.waitForSelector("[data-companion-pod-panel]", { timeout: 10_000 });
  const toggledText = await page.textContent("[data-companion-pod-panel]");
  check(`${vp.name}: toggle keeps the finished narration`,
    toggledText?.includes("Paragraph 24.") === true);

  // ✕ ends the narration; the pod remembers it as the replayable latest.
  await page
    .locator("[data-companion-pod-panel]")
    .getByRole("button", { name: "Close" })
    .click();
  await page.waitForSelector("[data-companion-pod-panel]", { state: "detached", timeout: 10_000 });
  m = await page.evaluate(MEASURE);
  check(`${vp.name}: button rests after dismissal`, m.podActive === "false");
  await page.click("[data-companion-pod]");
  await page.waitForSelector("[data-companion-pod-panel]", { timeout: 10_000 });
  const replayText = await page.textContent("[data-companion-pod-panel]");
  check(`${vp.name}: ✕ dismisses into a replayable latest`,
    replayText?.includes("Paragraph 24.") === true);

  await ctx.close();
}

// ── Main ────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
try {
  if (!externalBase) {
    await bootServer();
  } else {
    console.log(`[probe-pod] probing live server at ${externalBase}`);
  }
  for (const vp of VIEWPORTS) {
    console.log(`\n${vp.name}`);
    await runViewport(browser, vp);
  }
} finally {
  await browser.close();
  await shutdownServer();
}

console.log(
  failures === 0
    ? "\nPod geometry verified at every viewport — nothing overlaps."
    : `\n${failures} assertion(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
