import { describe, expect, it } from "vitest";
import { panBoundsFor, clampViewCentre } from "@/lib/timeline3d/desk-camera";
import { fitPaperZoom, PAPER_HEIGHT, PAPER_WIDTH, PAPER_ZOOM_MAX, paperPageCount, paperZoomAtMin, stepPaperZoom } from "@/components/desk/paper-view";

describe("fixed A4 viewing geometry", () => {
  it.each([[320, 440], [390, 640], [1280, 600], [1920, 900]])("fits an unchanged print sheet into %i × %i", (width, height) => {
    const zoom = fitPaperZoom(width, height);
    expect(PAPER_WIDTH / PAPER_HEIGHT).toBeCloseTo(210 / 297, 10);
    expect(PAPER_WIDTH * zoom).toBeLessThanOrEqual(width - 39.99);
    expect(PAPER_HEIGHT * zoom).toBeLessThanOrEqual(height - 39.99);
    expect(panBoundsFor(PAPER_WIDTH, PAPER_HEIGHT, width, height, zoom)).toEqual({ x: 0, y: 0 });
  });

  it("can enlarge phone print to actual reading scale and return to the exact fit", () => {
    const fit = fitPaperZoom(390, 640);
    let zoom = fit;
    for (let i = 0; i < 30; i++) zoom = stepPaperZoom(zoom, 1, fit);
    expect(zoom).toBe(PAPER_ZOOM_MAX);
    const seen = [];
    for (let i = 0; i < 30; i++) {
      zoom = stepPaperZoom(zoom, -1, fit);
      seen.push(zoom);
    }
    expect(seen).toContain(fit);
    expect(paperZoomAtMin(zoom, fit)).toBe(true);
  });

  it("can pan to all four print edges when enlarged without losing the sheet", () => {
    const zoom = 1.15, width = 390, height = 640;
    const bounds = panBoundsFor(PAPER_WIDTH, PAPER_HEIGHT, width, height, zoom);
    const bottomRight = clampViewCentre({ x: 1e6, y: 1e6 }, bounds);
    expect((PAPER_WIDTH / 2 - bottomRight.x) * zoom).toBeCloseTo(width / 2);
    expect((PAPER_HEIGHT / 2 - bottomRight.y) * zoom).toBeCloseTo(height / 2);
    expect(clampViewCentre({ x: -1e6, y: -1e6 }, bounds)).toEqual({ x: -bounds.x, y: -bounds.y });
  });

  it("counts actual print columns without turning DOM pixel rounding into a blank page", () => {
    expect(paperPageCount(1882, 627)).toBe(3);
    expect(paperPageCount(627, 627)).toBe(1);
    expect(paperPageCount(0, 0)).toBe(1);
  });
});
