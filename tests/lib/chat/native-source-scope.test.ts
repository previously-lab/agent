import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSourceScopeForDeployment } from "@/lib/chat/native-source-scope.server";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

describe("native demo source identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hashes the configured remote demo origin without exposing it", () => {
    const remote = "https://fixture-user:fixture-secret@example.test/private-dataset";
    vi.stubEnv("STORAGE", "demo");
    vi.stubEnv("PREVIOUSLY_MODE", "cloud");
    vi.stubEnv("BENCHMARK_BASE_URL", remote);
    expect(nativeSourceScopeForDeployment()).toBe(`cloud:demo:${digest(remote)}`);
    const scope = nativeSourceScopeForDeployment();
    expect(scope).not.toContain("example.test");
    expect(scope).not.toContain("fixture-secret");
    expect(scope).not.toContain("previously-lab/you");
  });

  it("hashes the actual local demo root and distinguishes it from a remote origin", () => {
    vi.stubEnv("STORAGE", "demo");
    vi.stubEnv("PREVIOUSLY_MODE", "client");
    vi.stubEnv("BENCHMARK_BASE_URL", "");
    const local = join(process.cwd(), "..", "you");
    expect(nativeSourceScopeForDeployment()).toBe(`client:demo:${digest(local)}`);
    expect(nativeSourceScopeForDeployment()).not.toBe(`client:demo:${digest("https://example.test/other")}`);
  });
});
