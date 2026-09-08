import { describe, expect, test } from "bun:test";
import {
  annotationBoxIntersects,
  annotationNoteNeedsDisclosure,
  annotationViewportBox,
  clampAnnotationDialogPlacement,
  layoutAnnotationBadges,
} from "../src/components/timeline-annotation-layout";

describe("timeline annotation density layout", () => {
  test("spreads overlapping badges instead of stacking them", () => {
    const viewport = { left: 0, top: 0, right: 800, bottom: 600 };
    const laid = layoutAnnotationBadges(
      [
        { id: "a", ordinal: 1, left: 120, top: 80, incomplete: true },
        { id: "b", ordinal: 2, left: 120, top: 80, incomplete: false },
        { id: "c", ordinal: 3, left: 121, top: 81, incomplete: false },
      ],
      viewport,
    );
    expect(new Set(laid.map((marker) => `${marker.left},${marker.top}`)).size).toBe(3);
    expect(laid[0]?.left).toBe(120);
    expect(laid[1]?.left).toBe(140);
    expect(laid[2]?.left).toBe(160);
  });

  test("wraps a dense badge cluster before it leaves the viewport", () => {
    const viewport = { left: 0, top: 0, right: 200, bottom: 400 };
    const laid = layoutAnnotationBadges(
      Array.from({ length: 8 }, (_, index) => ({
        id: String(index + 1),
        ordinal: index + 1,
        left: 188,
        top: 40,
        incomplete: false,
      })),
      viewport,
    );
    expect(laid.every((marker) => marker.left <= viewport.right - 12)).toBe(true);
    expect(laid.some((marker) => marker.top > 40)).toBe(true);
  });

  test("hides quote geometry that has scrolled out of the timeline", () => {
    const viewport = annotationViewportBox(800, 600, {
      left: 0,
      top: 80,
      right: 800,
      bottom: 500,
    });
    expect(
      annotationBoxIntersects({ left: 40, right: 90, top: 20, bottom: 40 }, viewport),
    ).toBe(false);
    expect(
      annotationBoxIntersects({ left: 40, right: 90, top: 120, bottom: 140 }, viewport),
    ).toBe(true);
  });

  test("keeps a tall review list inside the viewport below the composer", () => {
    const placement = clampAnnotationDialogPlacement({
      triggerLeft: 24,
      triggerTop: 80,
      triggerBottom: 112,
      contentHeight: 1800,
      viewportWidth: 800,
      viewportHeight: 700,
    });
    expect(placement.above).toBe(false);
    expect(placement.maxHeight).toBeLessThanOrEqual(Math.floor(700 * 0.7));
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(700 - 12);
    expect(placement.top).toBeGreaterThanOrEqual(112);
  });

  test("opens a tall review list above a bottom composer without leaving the screen", () => {
    const placement = clampAnnotationDialogPlacement({
      triggerLeft: 24,
      triggerTop: 640,
      triggerBottom: 672,
      contentHeight: 1800,
      viewportWidth: 800,
      viewportHeight: 700,
    });
    expect(placement.above).toBe(true);
    expect(placement.top).toBeGreaterThanOrEqual(12);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(640);
  });

  test("collapses long notes and leaves short notes intact", () => {
    expect(annotationNoteNeedsDisclosure("Keep this exact constraint.")).toBe(false);
    expect(annotationNoteNeedsDisclosure("Keep this exact constraint.\n".repeat(40))).toBe(true);
    expect(annotationNoteNeedsDisclosure("x".repeat(281))).toBe(true);
  });
});
