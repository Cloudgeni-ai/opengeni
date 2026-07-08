/* ----------------------------------------------------------------------------
   Windowing math (`computeWindowRange`) — the deterministic core of the Changes
   tab's diff-pane virtualization (D2). Pure function, no DOM: given per-section
   heights + scroll offset + viewport, which sections mount.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { computeWindowRange } from "../src/hooks/use-windowed-sections";

const uniform = (n: number, h: number) => Array.from({ length: n }, () => h);

describe("computeWindowRange", () => {
  test("mounts only the sections overlapping the viewport (no overscan)", () => {
    // 10 sections × 100px, a 300px viewport at the top.
    const r = computeWindowRange(uniform(10, 100), 0, 300, 0);
    expect(r).toEqual({ start: 0, end: 3 }); // rows 0,1,2 span [0,300)
  });

  test("the window follows the scroll offset", () => {
    const r = computeWindowRange(uniform(10, 100), 250, 300, 0);
    // [250,550) overlaps rows 2..5.
    expect(r).toEqual({ start: 2, end: 6 });
  });

  test("overscan widens the window on both sides, clamped to bounds", () => {
    const top = computeWindowRange(uniform(10, 100), 0, 300, 2);
    expect(top).toEqual({ start: 0, end: 5 }); // 0..2 + 2 after; clamped at 0
    const mid = computeWindowRange(uniform(10, 100), 400, 300, 2);
    // [400,700) overlaps 4..6; ±2 -> 2..8 exclusive-end 9
    expect(mid).toEqual({ start: 2, end: 9 });
  });

  test("a huge change set still mounts only a bounded window", () => {
    const r = computeWindowRange(uniform(400, 120), 6000, 800, 3);
    const mounted = r.end - r.start;
    expect(mounted).toBeLessThan(20); // NOT 400 — real windowing
    expect(r.start).toBeGreaterThan(0);
  });

  test("a zero viewport (pre-layout / headless) mounts a small anchored window, not all", () => {
    const r = computeWindowRange(uniform(50, 100), 0, 0, 3);
    expect(r.start).toBe(0);
    expect(r.end).toBeLessThanOrEqual(4); // anchor 0 + overscan, never 50
  });

  test("variable heights: the offset maps to the right section", () => {
    // heights: [50, 300, 50, 300, 50]. offsets: 0,50,350,400,700,750.
    const heights = [50, 300, 50, 300, 50];
    // scrollTop 360 (inside section 2 which spans 350..400), viewport 20.
    const r = computeWindowRange(heights, 360, 20, 0);
    expect(r).toEqual({ start: 2, end: 3 });
  });

  test("empty input is inert", () => {
    expect(computeWindowRange([], 0, 500, 3)).toEqual({ start: 0, end: 0 });
  });
});
