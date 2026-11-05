import { describe, expect, it } from "vitest";
import { deriveWorkScopeBindings } from "@/lib/dialogue/scopes";

describe("deriveWorkScopeBindings", () => {
  it("mints one independent scope per trusted, canonical document pointer", () => {
    const bindings = deriveWorkScopeBindings([
      { ref: "dossier/previously" },
      { ref: "things/audio-gear" },
    ]);
    expect(bindings.independentScopes).toHaveLength(2);
    expect(bindings.independentScopes[0]?.refs).toEqual(["dossier/previously"]);
    expect(bindings.independentScopes[1]?.refs).toEqual(["things/audio-gear"]);
    expect(bindings.independentScopes[0]?.id).not.toBe(bindings.independentScopes[1]?.id);
    expect(bindings.independentScopes[0]?.id).toMatch(/^scope-[a-f0-9]{16}$/);
  });

  it("drops pointers that are not canonical document refs — the host only verifies explicit scope", () => {
    const bindings = deriveWorkScopeBindings([
      { ref: "tasks/speakers" },
      { ref: "../escape" },
      { ref: "a//b" },
      { ref: "records/9999-99-99-9999" },
    ]);
    // tasks/<case> IS a canonical case-document ref (the ledger's task refs
    // share that grammar); the malformed and out-of-grammar pointers drop.
    expect(bindings.independentScopes).toEqual([
      { id: expect.stringMatching(/^scope-[a-f0-9]{16}$/), refs: ["tasks/speakers"] },
    ]);
  });

  it("binds nothing when the input carried no trusted context", () => {
    expect(deriveWorkScopeBindings(undefined).independentScopes).toEqual([]);
    expect(deriveWorkScopeBindings([]).independentScopes).toEqual([]);
  });
});
