import { describe, expect, it } from "vitest";
import { RoomReplyError, sendRoomReply } from "@/lib/companion/room-reply";

describe("sendRoomReply", () => {
  it("posts one user UIMessage through the existing chat turn", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response("stream", {
        status: 200,
        headers: { "x-workflow-run-id": "run_1" },
      });
    }) as typeof fetch;

    await sendRoomReply({
      text: "  那天我也在想这件事。  ",
      locale: "zh",
      timezone: "Asia/Shanghai",
      fetchImpl,
    });

    expect(seenUrl).toBe("/api/chat");
    expect(seenInit?.method).toBe("POST");
    const body = JSON.parse(String(seenInit?.body));
    expect(body.timezone).toBe("Asia/Shanghai");
    expect(body.locale).toBe("zh");
    expect(body.messages).toHaveLength(1);
    const [message] = body.messages;
    expect(message.role).toBe("user");
    expect(typeof message.id).toBe("string");
    expect(message.parts).toEqual([
      { type: "text", text: "那天我也在想这件事。" },
    ]);
  });

  it("omits optional fields rather than sending empty ones", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenInit = init;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await sendRoomReply({ text: "hi", fetchImpl });
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      messages: [
        {
          id: expect.any(String),
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
    });
  });

  it("rejects an empty reply without touching the network", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await expect(
      sendRoomReply({ text: "   ", fetchImpl }),
    ).rejects.toBeInstanceOf(RoomReplyError);
    expect(calls).toBe(0);
  });

  it("rejects with the HTTP status when the turn is refused", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "origin" }), {
        status: 403,
      })) as typeof fetch;

    const error = await sendRoomReply({ text: "hi", fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RoomReplyError);
    expect((error as RoomReplyError).status).toBe(403);
  });

  it("rejects on network failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(
      sendRoomReply({ text: "hi", fetchImpl }),
    ).rejects.toBeInstanceOf(RoomReplyError);
  });
});
