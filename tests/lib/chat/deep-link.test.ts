/**
 * Deep-link parsing for the single-route shell.
 *
 * What remains of the contract is the cold-boot conversation anchor:
 * `?at=<sliceId>&atStart=<iso>`, consumed once by ChatPage and stripped so
 * a refresh never re-jumps. The rung (`?z=`) and the view (`?view=`) are
 * gone — the shell's navigation is in-memory state (shell-nav.ts), and
 * nothing in the session writes query params any more.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RUNG,
  parseAtParam,
  parseAtStartParam,
  stripAtParam,
} from "@/lib/chat/deep-link";

describe("DEFAULT_RUNG", () => {
  it("is the conversation — a bare visit opens the live stream", () => {
    expect(DEFAULT_RUNG).toBe("conversation");
  });
});

describe("parseAtParam", () => {
  it("extracts the slice id", () => {
    expect(parseAtParam("?at=2026-08-01-1000")).toBe("2026-08-01-1000");
    expect(parseAtParam("at=2026-08-01-1000")).toBe("2026-08-01-1000");
    expect(parseAtParam("?persona=user&at=abc")).toBe("abc");
  });

  it("treats missing / blank / 'now' as no anchor", () => {
    expect(parseAtParam("")).toBeNull();
    expect(parseAtParam("?at=")).toBeNull();
    expect(parseAtParam("?at=now")).toBeNull();
    expect(parseAtParam("?at=%20")).toBeNull();
  });

  it("decodes encoded ids", () => {
    expect(parseAtParam("?at=a%20b")).toBe("a b");
  });

  it("ignores other params riding in the same query string", () => {
    expect(parseAtParam("?view=game&at=2026-08-01-1000")).toBe("2026-08-01-1000");
  });
});

describe("stripAtParam", () => {
  it("removes only at and keeps the rest", () => {
    expect(stripAtParam("?at=x&persona=user")).toBe("?persona=user");
    expect(stripAtParam("?persona=user&at=x")).toBe("?persona=user");
    expect(stripAtParam("?at=x")).toBe("");
    expect(stripAtParam("")).toBe("");
  });

  it("keeps unrelated params — only the one-shot anchor is consumed", () => {
    // The chat page strips `at` after it has jumped. Everything else in
    // the query string is not its to touch (debug params, skins…).
    expect(stripAtParam("?debug=rooms&at=x")).toBe("?debug=rooms");
    expect(stripAtParam("?at=x&skin=taiga")).toBe("?skin=taiga");
  });

  it("strips atStart along with at", () => {
    expect(
      stripAtParam("?at=x&atStart=2026-08-11T10%3A00%3A00.000Z&persona=user"),
    ).toBe("?persona=user");
    expect(stripAtParam("?atStart=2026-08-11T10:00:00.000Z")).toBe("");
  });
});

describe("parseAtStartParam", () => {
  it("extracts the ISO start", () => {
    expect(parseAtStartParam("?at=x&atStart=2026-08-11T10:00:00.000Z")).toBe(
      "2026-08-11T10:00:00.000Z",
    );
    expect(parseAtStartParam("atStart=2026-08-11T10%3A00%3A00.000Z")).toBe(
      "2026-08-11T10:00:00.000Z",
    );
  });

  it("treats missing / blank / non-date values as no anchor", () => {
    expect(parseAtStartParam("?at=x")).toBeNull();
    expect(parseAtStartParam("?atStart=")).toBeNull();
    expect(parseAtStartParam("?atStart=%20")).toBeNull();
    expect(parseAtStartParam("?atStart=not-a-date")).toBeNull();
  });
});
