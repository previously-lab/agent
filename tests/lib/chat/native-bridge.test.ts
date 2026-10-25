import { describe, expect, it } from "vitest";
import {
  NATIVE_BRIDGE_CHANNEL,
  validateNativeFrameMessage,
} from "@/lib/chat/native-bridge";

const token = "48-byte-cryptographic-token";
const source = { frame: "expected" };

function message(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { channel: NATIVE_BRIDGE_CHANNEL, token, type, ...extra };
}

describe("native iframe bridge validation", () => {
  it("requires the exact contentWindow and per-instance token", () => {
    expect(validateNativeFrameMessage(message("ready"), source, source, token)).toEqual(message("ready"));
    expect(validateNativeFrameMessage(message("ready"), {}, source, token)).toBeNull();
    expect(validateNativeFrameMessage(message("ready"), source, null, token)).toBeNull();
    expect(validateNativeFrameMessage(message("ready"), source, source, "other")).toBeNull();
    expect(validateNativeFrameMessage({ ...message("ready"), token: "other" }, source, source, token)).toBeNull();
    expect(validateNativeFrameMessage({ ...message("ready"), channel: "other" }, source, source, token)).toBeNull();
  });

  it("accepts only bounded, correctly typed messages", () => {
    expect(validateNativeFrameMessage(message("resize", { height: 320.4 }), source, source, token)).toMatchObject({ height: 320 });
    for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 32_769, "320"]) {
      expect(validateNativeFrameMessage(message("resize", { height }), source, source, token)).toBeNull();
    }
    expect(validateNativeFrameMessage(message("state", { json: "{\"controls\":[]}" }), source, source, token)).toMatchObject({ type: "state" });
    expect(validateNativeFrameMessage(message("state", { json: "x".repeat(16_385) }), source, source, token)).toBeNull();
    expect(validateNativeFrameMessage(message("followup", { prompt: "  Continue this  " }), source, source, token)).toMatchObject({ prompt: "Continue this" });
    expect(validateNativeFrameMessage(message("followup", { prompt: "   " }), source, source, token)).toBeNull();
    expect(validateNativeFrameMessage(message("followup", { prompt: "x".repeat(2_001) }), source, source, token)).toBeNull();
    expect(validateNativeFrameMessage(message("error", { message: "x".repeat(600) }), source, source, token)).toMatchObject({ message: "x".repeat(500) });
    expect(validateNativeFrameMessage(message("unknown"), source, source, token)).toBeNull();
    expect(validateNativeFrameMessage("ready", source, source, token)).toBeNull();
  });
});
