import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // `.claude/**` holds agent GIT WORKTREES — full checkouts of this repo
    // living inside it. Without this they are scanned as sources: the suite
    // runs every worktree's copy of every test (including its Playwright specs,
    // which vitest is not meant to touch), so a run that should take eight
    // seconds takes four minutes and reports failures from branches that are
    // not this one.
    // `.next-probe/**` / `.next-e2e/**` are the NEXT_DIST_DIR litter of the
    // dev-smoke / e2e gates — while they exist they carry compiled dependency
    // test files (e.g. @vercel/oidc) that the root-anchored `node_modules/**`
    // above does not catch.
    exclude: [
      "tests/e2e/**",
      "node_modules/**",
      ".next/**",
      ".next-probe/**",
      ".next-e2e/**",
      "dist-kernel/**",
      ".claude/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
