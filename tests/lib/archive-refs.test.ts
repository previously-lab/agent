/**
 * The non-case ref grammar (v0.25b §三): `records/<sliceId>` and
 * `dossier/<name>`. The record pattern's strictness is the security line —
 * it is the only thing standing between the ref text and the slice read.
 */
import { describe, expect, it } from "vitest";

import {
  deskRefKind,
  parseDossierRef,
  parseRecordRef,
} from "@/lib/archive/refs";

describe("parseRecordRef", () => {
  it("accepts the live slice id shape", () => {
    expect(parseRecordRef("records/2026-10-05-1430")).toEqual({
      sliceId: "2026-10-05-1430",
    });
  });

  it("rejects anything that is not four digit segments", () => {
    expect(parseRecordRef("records/2026-10-5-1430")).toBeNull();
    expect(parseRecordRef("records/2026-10-05-14300")).toBeNull();
    expect(parseRecordRef("records/2026-10-05-1430/extra")).toBeNull();
    expect(parseRecordRef("records/../CHARTER")).toBeNull();
    expect(parseRecordRef("records/")).toBeNull();
    expect(parseRecordRef("research/手机调研")).toBeNull();
  });
});

describe("parseDossierRef", () => {
  it("knows the Dossier's two documents, and only those", () => {
    expect(parseDossierRef("dossier/previously")).toEqual({ name: "previously" });
    expect(parseDossierRef("dossier/direction")).toEqual({ name: "direction" });
    expect(parseDossierRef("dossier/charter")).toBeNull();
    expect(parseDossierRef("dossier/")).toBeNull();
    expect(parseDossierRef("dossier")).toBeNull();
  });
});

describe("deskRefKind", () => {
  it("routes records and dossiers before the case grammar", () => {
    expect(deskRefKind("records/2026-10-05-1430")).toBe("record");
    expect(deskRefKind("dossier/direction")).toBe("dossier");
    expect(deskRefKind("research/手机调研")).toBe("case");
    expect(deskRefKind("records/not-a-slice")).toBe("case");
  });
});
