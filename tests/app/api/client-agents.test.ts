import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/client/agents/route";

describe("retired external-agent discovery endpoint", () => {
  it("reports removal without detecting executables or exposing machine paths", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    try {
      const result = await GET();
      expect(result.status).toBe(410);
      const body = await result.json();
      expect(body.error).toContain("DeepSeek");
      expect(body).not.toHaveProperty("agents");
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
});
