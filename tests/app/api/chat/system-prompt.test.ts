import { describe, it, expect } from "vitest";
import { type ModelMessage } from "@/lib/deepseek/types";
import {
  assembleSystemPrompt,
  appendContextSuffix,
  SPACE_FICTION_BLOCK,
} from "@/app/api/chat/turn-workflow";
import { CHARTER_MD } from "@/lib/identity/agent-prompt.generated";

const IDENTITY = "THE CHARTER";
const PREVIOUSLY = "# Previously card";
const DIRECTION = "## Direction — who the user is (evolved portrait)";
const SLICE_HEAD =
  "## This slice — snapshot at its start\n- Slice started: 02 Aug 2026, 14:32 (Asia/Shanghai, UTC+8)";
const DEMO = "## Demo mode (read-only)";

type Opts = Parameters<typeof assembleSystemPrompt>[0];

function build(overrides: Partial<Opts> = {}): string {
  return assembleSystemPrompt({
    identityPrompt: IDENTITY,
    previouslyContent: PREVIOUSLY,
    sliceHeadBlock: SLICE_HEAD,
    demoNotice: DEMO,
    dateAnchor: "2026-08-09",
    ...overrides,
  });
}

describe("assembleSystemPrompt (v0.9 slice-level freeze)", () => {
  it("orders layers by stability: L0 charter → L0b space fiction → L1b direction → L1a assisting → L1 card → L3 slice head → L5 demo → L6 due tasks", () => {
    const ASSISTING = "## Who you're assisting\nName: Alan";
    const DUE = "## Background work that landed today";
    const s = build({
      directionBlock: DIRECTION,
      assistingBlock: ASSISTING,
      dueTasksBlock: DUE,
    });
    expect(s.indexOf(IDENTITY)).toBe(0); // L0 leads the prompt
    expect(s.indexOf(SPACE_FICTION_BLOCK)).toBeGreaterThan(s.indexOf(IDENTITY));
    // WHO (the user model) frames the reading of WHAT (the card).
    expect(s.indexOf(DIRECTION)).toBeGreaterThan(s.indexOf(SPACE_FICTION_BLOCK));
    // L1a — the assisting tail sits with the user-model layers, out of L0.
    expect(s.indexOf(ASSISTING)).toBeGreaterThan(s.indexOf(DIRECTION));
    expect(s.indexOf(ASSISTING)).toBeLessThan(s.indexOf(PREVIOUSLY));
    expect(s.indexOf(PREVIOUSLY)).toBeGreaterThan(s.indexOf(ASSISTING));
    expect(s.indexOf(SLICE_HEAD)).toBeGreaterThan(s.indexOf(PREVIOUSLY));
    expect(s.indexOf(DEMO)).toBeGreaterThan(s.indexOf(SLICE_HEAD)); // L5 tail
    expect(s.indexOf(DUE)).toBeGreaterThan(s.indexOf(DEMO)); // L6 — the very tail
    expect(s.trim().endsWith(DUE)).toBe(true);
  });

  it("CORE REGRESSION: byte-identical when assembled twice within one slice (prefix cache)", () => {
    // Every input is anchored to the slice head, so two turns of the same
    // slice assemble the exact same bytes. There is deliberately NO per-turn
    // parameter left on Opts (Sent:/intent/emotional/semantic links were
    // retired in v0.9) — this test pins the freeze contract.
    const turn1 = build();
    const turn2 = build();
    expect(turn2).toBe(turn1);
    expect(turn2.length).toBeGreaterThan(0);
  });

  it("has no evolution-notice parameter — the birth evolution rides inside the frozen slice-head block", () => {
    const s = build({
      sliceHeadBlock: `${SLICE_HEAD}\n- The user card was updated just as this slice began: sharpened the profile.`,
    });
    expect(s).toContain("The user card was updated just as this slice began");
    // …and it lives in L3, before the demo notice tail.
    expect(s.indexOf("user card was updated")).toBeLessThan(s.indexOf(DEMO));
  });

  it("omits the demo notice when empty", () => {
    const s = build({ demoNotice: "" });
    expect(s).not.toContain("Demo mode");
  });

  it("NEVER renders the retired layers (v0.19 A1 撤清单): no strands menu, no timeline brief, no overdue block, no view block", () => {
    const s = build({ directionBlock: DIRECTION });
    expect(s).not.toContain("## Memory topics");
    expect(s).not.toContain("## Timeline (recent)");
    expect(s).not.toContain("## 逾期承诺");
    expect(s).not.toContain("## Overdue commitments");
    expect(s).not.toContain("[当前]");
  });

  it("the space fiction states the co-built space without referencing any per-turn view signal (A1)", () => {
    expect(SPACE_FICTION_BLOCK).toContain("Nobody lives in this space");
    expect(SPACE_FICTION_BLOCK).toContain("the same screen");
    expect(SPACE_FICTION_BLOCK).not.toContain("[当前]");
    expect(build()).toContain(SPACE_FICTION_BLOCK);
  });

  it("renders the card-freshness header with the slice-head date anchor", () => {
    expect(build()).toContain(
      "## What I know about the user — the living recap (2026-08-09)",
    );
  });

  it("places the direction block before the card — absent by default", () => {
    const s = build({ directionBlock: DIRECTION });
    expect(s).toContain(DIRECTION);
    expect(s.indexOf(DIRECTION)).toBeGreaterThan(s.indexOf(IDENTITY));
    expect(s.indexOf(DIRECTION)).toBeLessThan(s.indexOf(PREVIOUSLY));
    // Default: the layer is omitted entirely (template / legacy direction docs).
    expect(build()).not.toContain("Direction — who the user is");
  });

  it("places the assisting block (L1a) between the direction and the card header — omitted when absent", () => {
    const ASSISTING = "## Who you're assisting\nName: Alan";
    const s = build({ directionBlock: DIRECTION, assistingBlock: ASSISTING });
    expect(s.indexOf(ASSISTING)).toBeGreaterThan(s.indexOf(DIRECTION));
    expect(s.indexOf(ASSISTING)).toBeLessThan(
      s.indexOf("## What I know about the user"),
    );
    // Default: the layer is omitted entirely (no identity head).
    expect(build()).not.toContain("Who you're assisting");
  });

  it("carries NO inline static-rules layer — the two documents' contract lives in the charter (L0), stated once", () => {
    const s = build({ directionBlock: DIRECTION });
    expect(s).not.toContain("GROUNDING RULE");
    expect(s).not.toContain("The recap above holds WHAT");
  });

  it("places the user's self-description (L1c) right after the card, before the slice head — omitted when absent", () => {
    const PROFILE =
      "## The user's own words about themselves (profile.md)\n\n我是设计师。\n\nThis is the user's self-description — they wrote it directly, and only they can change it. When it conflicts with anything in the model above, THE SELF-DESCRIPTION WINS; treat the model entry as stale and say so when it comes up.";
    const s = build({ directionBlock: DIRECTION, userProfileBlock: PROFILE });
    expect(s).toContain("THE SELF-DESCRIPTION WINS");
    expect(s.indexOf(PROFILE)).toBeGreaterThan(s.indexOf(PREVIOUSLY));
    expect(s.indexOf(PROFILE)).toBeLessThan(s.indexOf(SLICE_HEAD));
    // Default: the layer is omitted entirely (no profile.md).
    expect(build()).not.toContain("self-description");
  });
});

describe("appendContextSuffix (outbound-only tail injection)", () => {
  const LINE = "\n\n[Current time: x]";

  it("appends to the LAST user message's string content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "second" },
    ];
    const out = appendContextSuffix(msgs, LINE);
    expect(out[2]).toEqual({ role: "user", content: "second" + LINE });
    expect(out[0]).toEqual({ role: "user", content: "first" });
    // Outbound copy only — the input is untouched.
    expect(msgs[2]).toEqual({ role: "user", content: "second" });
  });

  it("appends a text part to array content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const out = appendContextSuffix(msgs, LINE);
    const content = (out[0] as { content: Array<{ type: string; text?: string }> })
      .content;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "text", text: LINE });
  });

  it("is a no-op when the window has no user message", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: "hi" }];
    expect(appendContextSuffix(msgs, LINE)).toEqual(msgs);
  });
});

describe("the field/reflection charter (v0.30)", () => {
  it("frames the agent as ONE agent in two execution units — the field (with the mouth) and the reflection unit (without one)", () => {
    expect(CHARTER_MD).toContain("ONE agent in two execution units");
    expect(CHARTER_MD).toContain("**field unit**");
    expect(CHARTER_MD).toContain("**reflection unit**");
    expect(CHARTER_MD).toContain("it wakes mechanically when a turn ends — you never send it anything");
  });

  it("carries the v0.30 write discipline: the pen is the exception — only a user-named task earns a write, and the revisit bar is gone", () => {
    expect(CHARTER_MD).toContain("Your pen is the exception; your voice is the rule");
    expect(CHARTER_MD).toContain("the user explicitly asks you to write something down");
    expect(CHARTER_MD).toContain("write it first, then answer from what you wrote");
    expect(CHARTER_MD).toContain("you never announce a write");
    // R6: the read-back-before-mentioning discipline stays.
    expect(CHARTER_MD).toContain("never tell the user a document exists until you have read it back with `recallRead`");
    // The revisit bar retired with the dispatch (v0.30 §6(d)) — the field no
    // longer decides autonomously what deserves a document.
    expect(CHARTER_MD).not.toContain("revisit bar");
    expect(CHARTER_MD).not.toContain("will be revisited");
  });

  it("positions writeCase as the field's single-job write (a user-named task), with the tasks naming discipline", () => {
    expect(CHARTER_MD).toContain("stays on your tool surface for one job");
    expect(CHARTER_MD).toContain("Categories `people/user` and `self/` still refuse you");
    // The category semantics: what the case IS decides, not what it mentions.
    expect(CHARTER_MD).toContain("what the case IS, not what it mentions");
    // §6(f): hypotheses carry their falsification condition.
    expect(CHARTER_MD).toContain("`hypotheses/` (state what would falsify it)");
    // The naming discipline: a task case is named specific to one action.
    expect(CHARTER_MD).toContain("named specific to one action");
    // The old "one bounded exception, research only" framing is gone, and so
    // is the v0.21 "every category but two" autonomy.
    expect(CHARTER_MD).not.toContain("ONE bounded exception");
    expect(CHARTER_MD).not.toContain("every category accepts your write");
  });

  it("reserves people/user and self/ writes to the reflection unit", () => {
    expect(CHARTER_MD).toContain("**You never write it**");
    expect(CHARTER_MD).toContain("the reflection unit's write surface alone");
    expect(CHARTER_MD).toContain("yours to read, the reflection unit's to write");
  });

  it("carries the reflection-unit section: woken mechanically, never messaged, a one-line note waits at the next turn", () => {
    expect(CHARTER_MD).toContain("### The reflection unit");
    expect(CHARTER_MD).toContain("it is woken mechanically after each turn");
    expect(CHARTER_MD).toContain("You do not message it");
    expect(CHARTER_MD).toContain("a one-line note waits for you at your next turn");
    expect(CHARTER_MD).toContain("you answer now, or start the long work");
    // The dispatch era is gone from the charter.
    expect(CHARTER_MD).not.toContain("Reporting to HQ");
    expect(CHARTER_MD).not.toContain("The payload is prose");
  });

  it("narrates ONE person to the user — the two units are never separate people", () => {
    expect(CHARTER_MD).toContain("To the user there is only ever you");
    expect(CHARTER_MD).toContain("it is you, working while the user is away");
    // The retired colleague metaphors are gone.
    expect(CHARTER_MD).not.toContain("one of your colleagues");
    expect(CHARTER_MD).not.toContain("researcher colleague");
    expect(CHARTER_MD).not.toContain("air support");
    // The copy metaphor replaced them.
    expect(CHARTER_MD).toContain("one of your copies is dispatched");
    expect(CHARTER_MD).toContain("a search-desk copy of yourself");
  });

  it("pins the language rule: prompts are English, memory documents are the user's language and never mixed", () => {
    expect(CHARTER_MD).toContain("The languages of your work");
    expect(CHARTER_MD).toContain("Prompts and instructions are English");
    expect(CHARTER_MD).toContain("written in the user's own language, and one document never mixes languages");
  });

  it("teaches the write-window lifecycle, not the retired closed/draft one (v0.21 §12)", () => {
    // The header is opened + a mechanical updated stamp the model never touches.
    expect(CHARTER_MD).toContain("`updated`, a mechanical stamp");
    // The window decides rewriting: whole-body rewrites only while it is open.
    expect(CHARTER_MD).toContain("**write window**");
    expect(CHARTER_MD).toContain("each write within 30 minutes of the last");
    expect(CHARTER_MD).toContain("the body may be rewritten whole");
    // Past the window: dated tail lines / new pieces / a pointer at a new document.
    expect(CHARTER_MD).toContain("open a NEW document and leave one line in the original pointing at it");
    // The retired lifecycle is gone.
    expect(CHARTER_MD).not.toContain("an optional `closed`");
    expect(CHARTER_MD).not.toContain("may be rewritten freely");
    expect(CHARTER_MD).not.toContain("the body is frozen");
    expect(CHARTER_MD).not.toContain("a draft");
  });

  it("carries NONE of the retired mechanical-trigger or language-discipline wording (v0.21 撤出清单)", () => {
    // The old boundary-driven pipeline descriptions.
    expect(CHARTER_MD).not.toContain("runs at conversation boundaries");
    expect(CHARTER_MD).not.toContain("after the conversation closes");
    // v0.20's scrapped mechanics (triage / watermark lines / forced wake on close).
    expect(CHARTER_MD).not.toContain("triage");
    expect(CHARTER_MD).not.toContain("watermark");
    expect(CHARTER_MD).not.toContain("[bg-event]");
    expect(CHARTER_MD).not.toContain("[bg-done]");
    expect(CHARTER_MD).not.toContain("闭片必唤起");
    expect(CHARTER_MD).not.toContain("分诊");
    expect(CHARTER_MD).not.toContain("水位");
    // The overfit language discipline (裁决 11) never enters the prompt.
    expect(CHARTER_MD).not.toContain("只收陈述句");
    expect(CHARTER_MD).not.toContain("禁止承诺未来");
    expect(CHARTER_MD).not.toContain("statements only");
    expect(CHARTER_MD).not.toContain("never promise");
  });
});

describe("the grounding rule (a claim's home is decided by the claim's type)", () => {
  it("lives in the CHARTER (L0, highest priority), stated exactly once, with the tier split, the hard edge and the in-conversation exemptions", () => {
    expect(CHARTER_MD).toContain("THE GROUNDING RULE");
    // v0.15: the rule is tiered by CLAIM TYPE, not a blanket ban on the
    // compressed layer. Synthesis/pattern claims may be restated from a
    // document — but only with attribution and its time…
    expect(CHARTER_MD).toContain("a claim's home is decided by the claim's TYPE");
    expect(CHARTER_MD).toContain("Attribution is the price of the shortcut");
    // …while specific/event claims still enter only from the original slice
    // text: a document's whole right in that tier is to help find the slice.
    expect(CHARTER_MD).toContain("Specific / event claims");
    expect(CHARTER_MD).toContain("read FIRST, then answer");
    // The hard edge: anything acted or judged on needs slice evidence,
    // whatever a document says.
    expect(CHARTER_MD).toContain("The hard edge");
    // …with the exemptions: current slice, this conversation, and original
    // material already recalled/read into it.
    expect(CHARTER_MD).toContain("Three exemptions");
    // Stated exactly once — no second copy may drift from it.
    expect(CHARTER_MD.match(/GROUNDING RULE/g)).toHaveLength(1);
    // The charter declares its own supremacy over every other layer.
    expect(CHARTER_MD).toContain("NOTHING outranks it");
  });
});
