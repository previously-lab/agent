import { describe, expect, it } from "vitest";
import {
  cardVariantFor,
  columnFor,
  MIN_COLUMN_PX,
  paneWidthFor,
  railFootprintFor,
  specFor,
  tierFor,
  typeScaleFor,
  TIERS,
} from "@/lib/layout/tiers";

/** Every width the app is expected to meet, boundaries included. */
const SWEEP = [
  320, 360, 390, 414, 639, 640, 641, 767, 768, 1023, 1024, 1280, 1440, 1599,
  1600, 1920, 2560,
];

describe("tierFor", () => {
  it("puts each width in its tier, at the boundary", () => {
    expect(tierFor(320)).toBe("phone");
    expect(tierFor(639)).toBe("phone");
    expect(tierFor(640)).toBe("tablet");
    expect(tierFor(1023)).toBe("tablet");
    expect(tierFor(1024)).toBe("laptop");
    expect(tierFor(1599)).toBe("laptop");
    expect(tierFor(1600)).toBe("wide");
  });

  it("is total above zero and never falls off the table", () => {
    for (const w of [0, 1, 200, 5000]) {
      expect(TIERS.some((t) => t.id === tierFor(w))).toBe(true);
    }
  });

  it("has tiers in ascending order of their lower bound", () => {
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i].minWidth).toBeGreaterThan(TIERS[i - 1].minWidth);
    }
  });
});

describe("columnFor", () => {
  it("fills the pane on a phone instead of overflowing it", () => {
    // The bug this module exists for: the column was a flat 680 and a 390px
    // phone cropped 14 of its 16 text nodes. This is that assertion inverted.
    expect(columnFor(390)).toBe(342); // 390 - 32 rail - 2*8 inset
    expect(columnFor(320)).toBe(272);
    expect(columnFor(390)).toBeLessThan(paneWidthFor(390));
  });

  it("reaches the cap once there is room, and stays there", () => {
    expect(columnFor(768)).toBe(680);
    expect(columnFor(1024)).toBe(680);
    expect(columnFor(1440)).toBe(680);
    expect(columnFor(1599)).toBe(680);
  });

  it("grows once, at the wide tier, where the room is", () => {
    expect(columnFor(1600)).toBe(760);
    expect(columnFor(2560)).toBe(760);
  });

  it("never narrows as the window widens at a tier boundary", () => {
    // The clamp's whole job. A fixed per-tier width would step here; the only
    // movement left is the inset's own few px, which TIERS keeps at the
    // boundaries where the column is already pinned to its cap.
    expect(columnFor(1023)).toBe(columnFor(1024));
    expect(columnFor(767)).toBe(columnFor(768));
    expect(columnFor(1599)).toBeLessThan(columnFor(1600));
  });

  it("never exceeds the room the pane leaves it", () => {
    for (const w of SWEEP) {
      const spec = specFor(tierFor(w));
      expect(columnFor(w)).toBeLessThanOrEqual(paneWidthFor(w) - 2 * spec.inset);
    }
  });

  it("never goes below the readable floor", () => {
    for (const w of SWEEP) {
      expect(columnFor(w)).toBeGreaterThanOrEqual(MIN_COLUMN_PX);
    }
  });

  it("is monotonic for a window growing past the phone tier", () => {
    let prev = 0;
    for (const w of [320, 360, 390, 414, 639, 640, 700, 768, 1024, 1400]) {
      const c = columnFor(w);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe("cardVariantFor", () => {
  it("gives the narrow tiers the portrait document", () => {
    expect(cardVariantFor(390)).toBe("portrait");
    expect(cardVariantFor(768)).toBe("portrait");
  });

  it("gives the wide tiers the dossier", () => {
    expect(cardVariantFor(1024)).toBe("dossier");
    expect(cardVariantFor(1440)).toBe("dossier");
  });
});

describe("railFootprintFor / paneWidthFor", () => {
  it("takes the rail and its margin off the window", () => {
    expect(railFootprintFor(390)).toBe(32); // 8 margin + 24 rail
    expect(paneWidthFor(390)).toBe(358);
    expect(paneWidthFor(1440)).toBe(1440 - 48);
  });

  it("never returns a negative pane", () => {
    expect(paneWidthFor(10)).toBe(0);
  });
});

describe("typeScaleFor", () => {
  it("shrinks the field's fixed type on a phone", () => {
    expect(typeScaleFor(390)).toBeLessThan(1);
    expect(typeScaleFor(1440)).toBe(1);
    expect(typeScaleFor(1920)).toBeGreaterThan(1);
  });
});
