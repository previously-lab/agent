import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAvailableModels } from "@/lib/models/catalog";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("fixed model catalog", () => {
  it("never queries a remote provider catalog", async () => {
    const request = vi.fn(() => { throw new Error("External requests forbidden"); });
    vi.stubGlobal("fetch", request);
    vi.stubEnv("PREVIOUSLY_MODE", "cloud");
    vi.stubEnv("DEEPSEEK_API_KEY", "fixture-key");
    expect((await resolveAvailableModels()).map((model) => model.id)).toEqual(["deepseek-flash"]);
    expect(request).not.toHaveBeenCalled();
  });
});
