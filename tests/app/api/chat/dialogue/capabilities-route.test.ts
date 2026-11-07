import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ store: vi.fn(), scope: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/dialogue/runtime", () => ({
  getDialogueStore: h.store,
  resolveDialogueScope: h.scope,
  guardDialogueRead: h.guard,
  dialogueResponseError: () => Response.json({ code: "dialogue_disabled" }, { status: 409 }),
}));

import { GET } from "@/app/api/chat/dialogue/route";

beforeEach(() => { vi.resetAllMocks(); h.scope.mockReturnValue("scope"); });

it("detects v2 without reading any legacy events", async () => {
  const response = await GET(new Request("http://localhost/api/chat/dialogue?capabilities=1&persona=reader"));
  expect(await response.json()).toEqual({ version: 2, enabled: true });
  expect(h.scope).toHaveBeenCalledWith("reader");
  expect(h.store).not.toHaveBeenCalled();
});

it("retains the disabled response for the demo archive", async () => {
  h.scope.mockImplementation(() => { throw new Error("demo"); });
  const response = await GET(new Request("http://localhost/api/chat/dialogue?capabilities=1"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "dialogue_disabled" });
  expect(h.store).not.toHaveBeenCalled();
});
