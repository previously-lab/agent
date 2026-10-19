/**
 * The banned-word table (v0.40 §2.5) — a MECHANICAL assertion over the i18n
 * values: the engineering vocabulary (git / commit / ref / sha / token /
 * workflow / run / slice / 429) must not appear in user-facing copy. The
 * panel is an engineering surface and the pre-existing PRODUCT vocabulary
 * (时间片 labels, settings screens, the version-sync hint) predates this
 * rule — those keys sit on an explicit, per-key justified allowlist; every
 * OTHER value must scan clean, including every string this batch added.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BANNED: Array<{ word: string; pattern: RegExp }> = [
  { word: "git", pattern: /(?<![a-z])git(?![a-z])/i },
  { word: "commit", pattern: /(?<![a-z])commit(?![a-z])/i },
  { word: "ref", pattern: /(?<![a-z])ref(?![a-z])/i },
  { word: "sha", pattern: /(?<![a-z])sha(?![a-z])/i },
  { word: "token", pattern: /(?<![a-z])token(?![a-z])/i },
  { word: "workflow", pattern: /(?<![a-z])workflow(?![a-z])/i },
  { word: "run", pattern: /(?<![a-z])run(?![a-z])/i },
  { word: "slice", pattern: /(?<![a-z])slice(?![a-z])/i },
  { word: "429", pattern: /429/ },
];

/**
 * Pre-existing keys whose values carry the BANNED words legitimately —
 * product vocabulary (时间片 is the product's own noun) or explicit
 * engineering surfaces (the settings' version-sync hint names the GitHub
 * credential). Each entry names its justification; a NEW hit must either
 * reword the string or extend this list with a reason, never silence the
 * scan.
 */
const ALLOWLIST: Record<string, string> = {
  "chat.phase.sliced": "product noun (time slice) on the housekeeping card",
  "chat.phase.slice-closed": "product noun on the housekeeping card",
  "chat.phase.slice": "product noun on the housekeeping card",
  "chat.history.notFound": "history surface, product noun",
  "chat.references.title": "product noun in the references bar",
  "timeline3d.lens.slice": "3D timeline lens label, product noun",
  "companion.narrateAria": "companion aria label, product noun",
  "settings.config.maxSliceMinutes": "settings label, product noun",
  "settings.config.maxTurnsPerSlice": "settings label, product noun",
  "settings.config.idleGapMinutes": "settings label, product noun",
  "settings.version.sync.failRetry":
    "settings/version surface naming the GitHub credential",
  "desk.notFoundBody": "desk shelf placeholder ({ref} template param)",
  // Pre-existing product-education copy (NOT failure copy — the table's
  // target): the loading tips teach the product's own nouns, and the demo
  // badge explains the demo deployment. Rewording this voice is the
  // product owner's call, not this scan's.
  "demo.badgeDesc": "demo badge copy (pre-existing product voice)",
  "chat.loadingTips.0": "loading tip — product noun (time slice)",
  "chat.loadingTips.2": "loading tip — product nouns (Markdown file, version diff)",
  "chat.loadingTips.6": "loading tip — product noun (time slice)",
  "chat.loadingTips.9": "loading tip — product noun (time slice)",
  "chat.loadingTips.13": "loading tip — background loop product copy",
  // Pre-existing panel labels (debug surface, product noun) — same
  // product-vocabulary class as the loading tips above.
  "companion.hqEmpty": "panel status line (pre-existing product voice)",
  "companion.hqActLog": "panel feed label (pre-existing)",
  "companion.debugActiveSlice": "debug row label, product noun",
};

function flatten(value: unknown, path: string, out: Map<string, string>): void {
  if (typeof value === "string") {
    out.set(path, value);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, path ? `${path}.${k}` : k, out);
    }
  }
}

describe("the banned-word table (v0.40 §2.5) — mechanical assertion", () => {
  for (const locale of ["en", "zh"] as const) {
    it(`${locale}.json — no banned word outside the justified allowlist`, () => {
      const raw = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../messages/${locale}.json`, import.meta.url)),
          "utf8",
        ),
      ) as unknown;
      const flat = new Map<string, string>();
      flatten(raw, "", flat);

      const violations: string[] = [];
      const allowlisted: string[] = [];
      for (const [path, value] of flat) {
        const hits = BANNED.filter((b) => b.pattern.test(value)).map((b) => b.word);
        if (hits.length === 0) continue;
        if (ALLOWLIST[path]) {
          allowlisted.push(`${path} (${hits.join(",")} — ${ALLOWLIST[path]})`);
          continue;
        }
        violations.push(`${path}: [${hits.join(", ")}] ${value.slice(0, 60)}`);
      }

      expect(
        violations,
        `banned words in user-facing copy:\n${violations.join("\n")}`,
      ).toEqual([]);
      // The allowlist stays honest: every entry must actually match at least
      // one value (a stale entry means someone silenced the scan by accident).
      expect(allowlisted.length).toBeGreaterThan(0);
    });
  }
});
