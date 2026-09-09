import { describe, expect, test } from "bun:test";
import {
  ANNOTATION_BADGE_GAP_PX,
  annotationBadgePackGap,
  annotationBoxIntersects,
  annotationNoteNeedsDisclosure,
  annotationViewportBox,
  clampAnnotationDialogPlacement,
  layoutAnnotationBadges,
  scrollAnnotationRowIntoList,
} from "../src/components/timeline-annotation-layout";

function uniqueBadgePoints(markers: Array<{ left: number; top: number }>): number {
  return new Set(markers.map((marker) => `${marker.left},${marker.top}`)).size;
}

function minBadgeDistance(markers: Array<{ left: number; top: number }>): number {
  let min = Number.POSITIVE_INFINITY;
  for (let index = 0; index < markers.length; index++) {
    for (let other = index + 1; other < markers.length; other++) {
      min = Math.min(
        min,
        Math.hypot(
          markers[index]!.left - markers[other]!.left,
          markers[index]!.top - markers[other]!.top,
        ),
      );
    }
  }
  return min;
}

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
    expect(uniqueBadgePoints(laid)).toBe(3);
    expect(minBadgeDistance(laid)).toBeGreaterThanOrEqual(ANNOTATION_BADGE_GAP_PX);
    expect(laid[0]?.left).toBe(120);
    expect(laid[1]?.left).toBe(152);
    expect(laid[2]?.left).toBe(184);
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
    expect(uniqueBadgePoints(laid)).toBe(8);
    expect(minBadgeDistance(laid)).toBeGreaterThanOrEqual(ANNOTATION_BADGE_GAP_PX);
    expect(laid.every((marker) => marker.left <= viewport.right - 12)).toBe(true);
    expect(laid.every((marker) => marker.top <= viewport.bottom - 12)).toBe(true);
    expect(laid.some((marker) => marker.top > 40)).toBe(true);
  });

  test("keeps a twelve-badge pile inside a short bottom-right viewport", () => {
    const viewport = { left: 0, top: 0, right: 220, bottom: 160 };
    const laid = layoutAnnotationBadges(
      Array.from({ length: 12 }, (_, index) => ({
        id: String(index + 1),
        ordinal: index + 1,
        left: 210,
        top: 148,
        incomplete: false,
      })),
      viewport,
    );
    expect(laid).toHaveLength(12);
    expect(uniqueBadgePoints(laid)).toBe(12);
    expect(minBadgeDistance(laid)).toBeGreaterThanOrEqual(ANNOTATION_BADGE_GAP_PX);
    expect(laid.every((marker) => marker.left >= 12 && marker.left <= 208)).toBe(true);
    expect(laid.every((marker) => marker.top >= 8 && marker.top <= 148)).toBe(true);
  });

  test("still separates twelve badges in a cramped phone viewport", () => {
    const viewport = { left: 0, top: 0, right: 80, bottom: 80 };
    const laid = layoutAnnotationBadges(
      Array.from({ length: 12 }, (_, index) => ({
        id: String(index + 1),
        ordinal: index + 1,
        left: 70,
        top: 70,
        incomplete: false,
      })),
      viewport,
    );
    expect(uniqueBadgePoints(laid)).toBe(12);
    expect(minBadgeDistance(laid)).toBeGreaterThanOrEqual(annotationBadgePackGap(viewport, 12));
    expect(laid.every((marker) => marker.left >= 12 && marker.left <= 68)).toBe(true);
    expect(laid.every((marker) => marker.top >= 8 && marker.top <= 68)).toBe(true);
  });

  test("hides quote geometry that has scrolled out of the timeline", () => {
    const viewport = annotationViewportBox(800, 600, {
      left: 0,
      top: 80,
      right: 800,
      bottom: 500,
    });
    expect(annotationBoxIntersects({ left: 40, right: 90, top: 20, bottom: 40 }, viewport)).toBe(
      false,
    );
    expect(annotationBoxIntersects({ left: 40, right: 90, top: 120, bottom: 140 }, viewport)).toBe(
      true,
    );
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

  test("keeps a tall review list inside a short landscape viewport", () => {
    const placement = clampAnnotationDialogPlacement({
      triggerLeft: 16,
      triggerTop: 48,
      triggerBottom: 80,
      contentHeight: 1800,
      viewportWidth: 700,
      viewportHeight: 120,
    });
    expect(placement.top).toBeGreaterThanOrEqual(12);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(120 - 12);
    expect(placement.maxHeight).toBeGreaterThanOrEqual(80);
  });

  test("collapses long notes and leaves short notes intact", () => {
    expect(annotationNoteNeedsDisclosure("Keep this exact constraint.")).toBe(false);
    expect(annotationNoteNeedsDisclosure("Keep this exact constraint.\n".repeat(40))).toBe(true);
    expect(annotationNoteNeedsDisclosure("x".repeat(281))).toBe(true);
  });

  test("scrolls only the review list when a later row is focused", () => {
    const list = {
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0, bottom: 120, left: 0, right: 240 }),
      scrollTop: 0,
    };
    const row = {
      getBoundingClientRect: () => ({ top: 180, bottom: 240, left: 0, right: 240 }),
    };
    scrollAnnotationRowIntoList(list as unknown as HTMLElement, row as unknown as HTMLElement);
    expect(list.scrollTop).toBe(120);
  });
});
