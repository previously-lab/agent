import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelById, resolveMainModelFromConfig } from "@/lib/models/resolve";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("model resolution", () => {
  it("fixes all entry points to Flash without reading memory or a remote catalog", async () => {
    const request = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", request);
    vi.stubEnv("PREVIOUSLY_DEFAULT_MODEL", "deepseek-v4-pro");
    vi.stubEnv("PREVIOUSLY_BRAIN", "bridge");
    for (const id of ["deepseek-v4-pro", "bridge/codex", "old-provider-model"]) expect((await resolveModelById(id)).id).toBe("deepseek-flash");
    expect((await resolveMainModelFromConfig()).id).toBe("deepseek-flash");
    expect(request).not.toHaveBeenCalled();
  });
});
