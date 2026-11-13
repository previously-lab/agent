import { beforeEach, describe, it, expect, vi } from "vitest";
import { getUserName, loadUserProfile, parseIdentityFromPreviously } from "@/lib/identity/user-profile";
import { newPreviouslyTemplate, serializePreviously } from "@/lib/episodic/previously-format";

const source = vi.hoisted(() => ({
  readUserModel: vi.fn(),
  findMostRecentPreviously: vi.fn(),
  readFileLocal: vi.fn(),
}));
vi.mock("@/lib/evolution/store", () => ({ readUserModel: source.readUserModel }));
vi.mock("@/lib/episodic/manager", () => ({ findMostRecentPreviously: source.findMostRecentPreviously }));
vi.mock("@/lib/tools/local-fs", () => ({ readFileLocal: source.readFileLocal }));

describe("live user identity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    source.findMostRecentPreviously.mockResolvedValue("## Identity\n\n- Name: Historical name");
    source.readFileLocal.mockResolvedValue("## Identity\n\n- Name: Historical name");
  });

  it("reads the current model on each load instead of a frozen snapshot", async () => {
    source.readUserModel
      .mockResolvedValueOnce({ card: "## Identity\n\n- Name: Current name" })
      .mockResolvedValueOnce({ card: "## Identity\n\n- Name: Updated name" });
    expect(await getUserName()).toBe("Current name");
    expect(await getUserName()).toBe("Updated name");
    expect(source.findMostRecentPreviously).not.toHaveBeenCalled();
    expect(source.readFileLocal).not.toHaveBeenCalled();
  });

  it("uses the empty default when the live model is absent, even with historical identity", async () => {
    source.readUserModel.mockResolvedValue(null);
    expect(await loadUserProfile()).toEqual({ name: "", body: "" });
    expect(source.findMostRecentPreviously).not.toHaveBeenCalled();
    expect(source.readFileLocal).not.toHaveBeenCalled();
  });

  it("logs an unavailable live model and never substitutes historical identity", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      source.readUserModel.mockRejectedValue(new Error("Current model read failed"));
      expect(await getUserName("You")).toBe("You");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("no historical fallback"), "Current model read failed");
      expect(source.findMostRecentPreviously).not.toHaveBeenCalled();
      expect(source.readFileLocal).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});

describe("parseIdentityFromPreviously", () => {
  it("parses identity from a v3 previously.md (身份与背景 under 用户侧写)", () => {
    const v3 = serializePreviously({
      sliceId: "2026-08-05-1644",
      updated: "2026-08-05T16:46:18.878Z",
      profile: {
        identity: [
          {
            text: "用户名叫 LikeDreamwalker（也写作 LikeDreamWalker），可用 Dream 称呼",
            refs: ["2026/07/26/1539-esXr7w"],
            confidence: "high",
            updated: "2026-07-26",
            obs: 2,
          },
          {
            text: "用户是 AI 全栈工程师",
            refs: ["2026/08/05/1420-GM3C6g"],
            confidence: "medium",
            updated: "2026-08-05",
          },
        ],
      },
      selfModel: {},
    });

    const profile = parseIdentityFromPreviously(v3);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("LikeDreamwalker");
    expect(profile!.addressAs).toBe("Dream");
    // Body carries only belief text, not meta lines.
    expect(profile!.body).toContain("用户是 AI 全栈工程师");
    expect(profile!.body).not.toContain("refs:");
    expect(profile!.body).not.toContain("confidence:");
  });

  it("returns null when there is no identity section", () => {
    const v3 = newPreviouslyTemplate("2026-08-05-1644");
    expect(parseIdentityFromPreviously(v3)).toBeNull();
  });

  it("falls back to the legacy v2 User identity header", () => {
    const v2 = `# Previously On

## 长期记忆

### User identity

- 用户名叫 LikeDreamwalker
  evidence: [2026/07/26/1539-esXr7w] | confidence: medium | updated: 2026-07-26 | obs: 1

## 短期记忆
`;
    const profile = parseIdentityFromPreviously(v2);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("LikeDreamwalker");
    expect(profile!.body).not.toContain("evidence:");
  });

  it("parses the card Identity head: name cuts at a parenthetical, aliases extracted", () => {
    const cardContent = `# Previously On

_Active slice: 2026-08-09-0435 | Format: user card | Updated: 2026-08-09T00:00:00Z_

## Identity

- Name: LikeDreamwalker (also written LikeDreamWalker)
- Alias: Dream、阿布
- Address them as: Dream
- Pronouns: he/him

## Profile

The user is an AI engineer.
`;
    const profile = parseIdentityFromPreviously(cardContent);
    expect(profile).not.toBeNull();
    // The name must NOT swallow the parenthetical editorial note.
    expect(profile!.name).toBe("LikeDreamwalker");
    expect(profile!.addressAs).toBe("Dream");
    expect(profile!.pronouns).toBe("he/him");
    expect(profile!.aliases).toEqual(["Dream", "阿布"]);
  });

  it("parses the English Alias line form too", () => {
    const cardContent = `# Previously On

_Active slice: 2026-08-09-0435 | Format: user card | Updated: 2026-08-09T00:00:00Z_

## Identity

- Name: Alan Yuan
- Also known as: Y, Al

## Profile

x
`;
    const profile = parseIdentityFromPreviously(cardContent);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Alan Yuan");
    expect(profile!.aliases).toEqual(["Y", "Al"]);
  });
});
