import { describe, expect, it } from "vitest";
import { createSlice, parseSlice, serializeSlice } from "@/lib/episodic/manager";

describe("persistent question identities", () => {
  it("round-trips identities containing spaces and URI characters", () => {
    const slice = createSlice("the original question", "UTC", "turn1");
    slice.turns[0].clientMessageId = "question / with % symbols";
    expect(parseSlice(serializeSlice(slice)).turns[0].clientMessageId).toBe("question / with % symbols");
  });

  it("retains the conversation when a hand-edited identity has invalid URI encoding", () => {
    const slice = createSlice("the original question", "UTC", "turn1");
    slice.turns[0].clientMessageId = "valid";
    const edited = serializeSlice(slice).replace("[message valid]", "[message invalid%]");
    expect(parseSlice(edited).turns).toEqual([expect.objectContaining({ turnId: "turn1", content: "the original question", clientMessageId: "invalid%" })]);
  });
});
