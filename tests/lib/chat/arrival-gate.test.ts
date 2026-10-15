import { describe, it, expect } from "vitest";
import {
  ARRIVAL_GATE_TIMEOUT_MS,
  raceArrivalVerdict,
} from "@/lib/chat/reconnect";

describe("raceArrivalVerdict", () => {
  it("resolves ok when the verdict lands in time", async () => {
    const r = await raceArrivalVerdict(Promise.resolve("v"), 50);
    expect(r).toEqual({ kind: "ok", verdict: "v" });
  });

  it("fails when the verdict hangs past the timeout", async () => {
    const r = await raceArrivalVerdict(new Promise<string>(() => {}), 10);
    expect(r).toEqual({ kind: "failed" });
  });

  it("fails when the verdict rejects", async () => {
    const r = await raceArrivalVerdict(
      Promise.reject(new Error("boom")),
      50,
    );
    expect(r).toEqual({ kind: "failed" });
  });

  it("the gate constant is 15s (well under the platform wall)", () => {
    expect(ARRIVAL_GATE_TIMEOUT_MS).toBe(15_000);
  });
});
