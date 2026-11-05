import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/chat/dialogue/dispatch-host", () => ({ dispatchDialogueDueScopes: dispatch }));

import { GET } from "@/app/api/chat/dialogue/dispatch/route";

const originalSecret = process.env.CRON_SECRET;
const request = (authorization?: string) => new Request("http://test.local/api/chat/dialogue/dispatch", {
  headers: authorization ? { authorization } : undefined,
});

describe("dialogue recovery cron route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    dispatch.mockReset();
    dispatch.mockResolvedValue({ scopes: 2, ran: 5, failed: 1 });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("is disabled when CRON_SECRET is absent without affecting the direct host entry", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request("Bearer anything"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "cron_secret_missing" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects missing and incorrect bearer credentials", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runs one bounded recovery sweep for the Vercel cron credential", async () => {
    const response = await GET(request("Bearer test-cron-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, scopes: 2, ran: 5, failed: 1 });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ scopeLimit: 16, jobsPerScope: 4 });
  });

  it("does not expose store failures", async () => {
    dispatch.mockRejectedValue(new Error("private backend detail"));
    const response = await GET(request("Bearer test-cron-secret"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "dialogue_unavailable",
      error: "The conversation store is temporarily unavailable",
    });
  });
});
