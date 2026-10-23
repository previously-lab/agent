import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/models/route";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("GET /api/models", () => {
  it("reports a fixed model and no credential/provider switching fields", async () => {
    vi.stubEnv("PREVIOUSLY_MODE", "cloud");
    vi.stubEnv("DEEPSEEK_API_KEY", "not-a-real-key");
    const fetch = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", fetch);
    const result = await GET();
    const body = await result.json();
    expect(result.status).toBe(200);
    expect(body.fixed).toBe(true);
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ id: "deepseek-flash", provider: "deepseek", supportsVision: true, defaultEffort: "high" });
    expect(JSON.stringify(body)).not.toContain("not-a-real-key");
    expect(fetch).not.toHaveBeenCalled();
  });
});
