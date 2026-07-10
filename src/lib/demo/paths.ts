/**
 * Demo-mode path + ref resolution, shared by the local-FS and GitHub read paths
 * so both behave identically.
 *
 * In DEMO_MODE, `memory/` reads are redirected to the seeded persona dataset
 * (`memory/demo/personal_14/`), and GitHub reads are pinned to `DEMO_REF` (the
 * demo branch) so a token-backed demo deployment reads the demo branch's data —
 * not the repo's default branch (main), which is intentionally empty.
 */
const DEMO_MODE = process.env.DEMO_MODE === "true";
const DEMO_PATH_PREFIX = "memory/demo/personal_14";

/** memory/... → memory/demo/personal_14/... in demo mode (idempotent). */
export function resolveDemoPath(path: string): string {
  if (
    DEMO_MODE &&
    path.startsWith("memory/") &&
    !path.startsWith(DEMO_PATH_PREFIX)
  ) {
    return path.replace(/^memory\//, `${DEMO_PATH_PREFIX}/`);
  }
  return path;
}

/** memory/demo/personal_14/... → memory/... so callers stay in the original namespace. */
export function unresolveDemoPath(path: string): string {
  if (DEMO_MODE && path.startsWith(`${DEMO_PATH_PREFIX}/`)) {
    return path.replace(`${DEMO_PATH_PREFIX}/`, "memory/");
  }
  return path;
}

/** The git ref (branch/tag/sha) demo GitHub reads are pinned to, if configured. */
export function demoRef(): string | undefined {
  return DEMO_MODE ? process.env.DEMO_REF || undefined : undefined;
}
