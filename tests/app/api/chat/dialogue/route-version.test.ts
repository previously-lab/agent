import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  legacy: vi.fn(),
  native: vi.fn(),
  legacyStart: vi.fn(),
  confirm: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
}));

vi.mock("@/app/api/chat/dialogue/accept", () => ({
  acceptDialogueTurn: h.legacy,
  acceptDialogueTurnV2: h.native,
}));
vi.mock("@/app/api/chat/start-turn", () => ({ startTurn: h.legacyStart }));
vi.mock("@/lib/tools/staged-images", () => ({
  reserveStagedImages: async () => ({ attachments: [], confirm: h.confirm, release: h.release }),
}));
vi.mock("@/lib/tools/chat-image-input", () => ({
  legacyMessageImages: () => [],
  withVerifiedImages: (messages: unknown) => messages,
}));

import { POST } from "@/app/api/chat/route";

function request(dialogueVersion: number) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify({
      dialogueVersion,
      messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    }),
  });
}

describe("dialogue transport version dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.legacy.mockResolvedValue(Response.json({ version: 1 }));
    h.native.mockResolvedValue(Response.json({ version: 2 }));
  });

  it("keeps v1 on legacy acceptance and explicitly routes v2 to native offers", async () => {
    expect(await (await POST(request(1))).json()).toEqual({ version: 1 });
    expect(h.legacy).toHaveBeenCalledOnce();
    expect(h.native).not.toHaveBeenCalled();
    expect(await (await POST(request(2))).json()).toEqual({ version: 2 });
    expect(h.native).toHaveBeenCalledOnce();
    expect(h.legacy).toHaveBeenCalledOnce();
    expect(h.legacyStart).not.toHaveBeenCalled();
  });

  it.each([1, 2])("releases the reservation when v%i acceptance rejects", async (version) => {
    const acceptance = version === 1 ? h.legacy : h.native;
    const failure = new Error(`v${version} acceptance failed`);
    acceptance.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(POST(request(version))).rejects.toBe(failure);
    } finally {
      consoleError.mockRestore();
    }

    expect(h.release).toHaveBeenCalledOnce();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
