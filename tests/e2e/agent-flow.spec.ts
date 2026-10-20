import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E_MEMORY_ROOT } from "./env";

/**
 * The agent pipeline, end to end — the one thing the unit suite cannot prove:
 * a real conversation turn → the summary stream's single commit → the
 * reflection round that reads it back.
 *
 * Assertions read the ISOLATED memory root (its git log and its slice files),
 * not screenshots: the product's truth is the record, so that is what a test
 * should look at.
 *
 * Cost: a real model runs these turns. They are therefore SKIPPED when no
 * model bridge is reachable (a build machine, a clean checkout), which also
 * keeps a `next build` from ever depending on credentials.
 */

const hasBridge = ((): boolean => {
  const explicit = process.env.PREVIOUSLY_BRIDGE_CMD;
  if (explicit) return fs.existsSync(explicit);
  try {
    execFileSync("previously", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!hasBridge, "no model bridge on this host — the agent e2e needs a live model");

test.describe.configure({ mode: "serial" });

const MEM = E2E_MEMORY_ROOT;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: MEM, encoding: "utf8" }).trim();
}

/** Every slice's core.md, as `{id, user, agent}` counts. */
function slices(): Array<{ id: string; user: number; agent: number }> {
  const out: Array<{ id: string; user: number; agent: number }> = [];
  const records = path.join(MEM, "records");
  if (!fs.existsSync(records)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "core.md") continue;
      const body = fs.readFileSync(full, "utf8");
      out.push({
        id: path.basename(path.dirname(full)),
        user: (body.match(/^## Turn .* \(user\)$/gm) ?? []).length,
        agent: (body.match(/^## Turn .* \(agent\)$/gm) ?? []).length,
      });
    }
  };
  walk(records);
  return out;
}

function summaries(): string[] {
  return git(["log", "--format=%s"]).split("\n").filter((s) => s.startsWith("Summary — "));
}

function rounds(): string[] {
  return git(["log", "--format=%s"]).split("\n").filter((s) => s.startsWith("Reflection round — "));
}

/** The `seen:` trailer of the newest reflection round (its body, not subject). */
function newestSeen(): string {
  const body = git(["log", "-1", "--format=%b", "--grep", "^Reflection round — "]);
  return body.split("\n").find((l) => l.startsWith("seen:")) ?? "";
}

async function waitFor(predicate: () => boolean, timeoutMs = 200_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("timed out waiting for the record to settle");
}

async function send(page: import("@playwright/test").Page, text: string): Promise<void> {
  const composer = page.locator("textarea").first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe("agent turn → summary → reflection", () => {
  test.setTimeout(300_000);

  test("one send lands one slice, one Summary commit, and a reflection round that saw it", async ({
    page,
  }) => {
    await page.goto("/zh/app", { waitUntil: "domcontentloaded" });
    await send(page, "记一下：我在考虑换手机，预算 5000。");

    await waitFor(() => summaries().length >= 1 && rounds().length >= 1 && slices().some((s) => s.agent >= 1));

    const all = slices();
    expect(all).toHaveLength(1);
    expect(all[0].user).toBe(1);
    expect(all[0].agent).toBe(1);
    expect(summaries()).toHaveLength(1);
    // The turn-level water level: the round names the slice AND the turn it ate.
    expect(newestSeen()).toMatch(/^seen: \d{4}-\d{2}-\d{2}-\d{4}#\S+/);
  });

  test("two sends share one slice, every turn is covered once, and reflection saw them", async ({
    page,
  }) => {
    await page.goto("/zh/app", { waitUntil: "domcontentloaded" });
    await send(page, "再记一下：我还在比两个牌子。");
    await page.waitForTimeout(1200);
    await send(page, "预算改成 6000。");

    await waitFor(() => {
      const all = slices();
      return all.some((s) => s.user >= 2 && s.agent >= 2) && rounds().length >= 2;
    });

    const multi = slices().find((s) => s.user >= 2) ?? null;
    expect(multi, "the two sends must land in ONE slice").not.toBeNull();
    expect(multi!.agent).toBe(multi!.user);

    // Coverage, not commit count: a burst lands one commit, and two sends may
    // legitimately be two bursts (the gap decides) — what must never happen is
    // a turn missing from the record, or one turn written twice.
    const bodies = git(["log", "--format=%b", "--grep", "^Summary — "]);
    const covered = bodies.match(/(?:user turn|reply) [A-Za-z0-9_-]+/g) ?? [];
    const coveredTurns = new Set(covered.map((line) => line.split(" ").pop()));
    expect(coveredTurns.size).toBeGreaterThanOrEqual(2);
    expect(bodies.match(/user turn /g)?.length ?? 0).toBeLessThanOrEqual(
      bodies.match(/reply /g)?.length ?? 0,
    );

    // The water level names turns, not just the slice.
    expect(newestSeen()).toMatch(/^seen: \d{4}-\d{2}-\d{2}-\d{4}#\S+/);
  });
});
