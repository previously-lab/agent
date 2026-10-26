import { describe, expect, it } from "vitest";
import {
  gameHostPresentation,
  initialGameHostState,
  reduceGameHostState,
} from "@/lib/workspace/game-host";

describe("lazy persistent game host", () => {
  it("does not mount for a cold app visit", () => {
    const state = initialGameHostState("/app", "source:user");
    expect(gameHostPresentation(state, "/app").mount).toBe(false);
  });

  it("mounts once, suspends off-route, and restores the same host on return", () => {
    const cold = initialGameHostState("/app", "source:user");
    const visited = reduceGameHostState(cold, { type: "route", pathname: "/game", lane: "source:user" });
    expect(visited.visited).toBe(true);
    expect(gameHostPresentation(visited, "/game")).toMatchObject({
      mount: true,
      active: true,
      hidden: false,
      inert: false,
      paused: false,
      suspended: false,
      frameloop: "always",
    });
    const app = reduceGameHostState(visited, { type: "route", pathname: "/app", lane: "source:user" });
    expect(app).toBe(visited);
    expect(gameHostPresentation(app, "/app")).toMatchObject({
      mount: true,
      active: false,
      hidden: true,
      inert: true,
      paused: true,
      suspended: true,
      frameloop: "never",
    });
    expect(gameHostPresentation(app, "/game")).toMatchObject({
      active: true,
      hidden: false,
      inert: false,
      frameloop: "always",
    });
  });

  it("resets deliberately on source/persona lane changes", () => {
    const visited = initialGameHostState("/game", "source:alice");
    const changed = reduceGameHostState(visited, { type: "route", pathname: "/game", lane: "source:bob" });
    expect(changed).toEqual({ visited: true, lane: "source:bob", epoch: 1 });
    const offRoute = reduceGameHostState(changed, { type: "route", pathname: "/app", lane: "source:carol" });
    expect(offRoute).toEqual({ visited: false, lane: "source:carol", epoch: 2 });
    expect(gameHostPresentation(offRoute, "/app").mount).toBe(false);
  });
});
