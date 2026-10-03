import { describe, expect, test } from "bun:test";

import { computeCalloutLayout } from "./callout";

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("callout layout", () => {
  test("the arrow ends exactly at the target's edge, on the chosen side", () => {
    const target = box(100, 400, 200, 40);
    const right = computeCalloutLayout(target, 44, desktop, ["right"])!;
    expect(right.bubble.left).toBe(target.right + 40);
    expect(right.arrow!.to).toEqual({ x: target.right + 6, y: 420 });
    expect(right.arrow!.from.x).toBe(right.bubble.left - 2);

    const below = computeCalloutLayout(target, 44, desktop, ["below"])!;
    expect(below.arrow!.to).toEqual({ x: 200, y: target.bottom + 6 });
    expect(below.bubble.top).toBe(target.bottom + 40);

    const above = computeCalloutLayout(target, 44, desktop, ["above"])!;
    expect(above.arrow!.to).toEqual({ x: 200, y: target.top - 6 });
    expect(above.bubble.top + 44).toBeLessThan(target.top);
  });

  test("skips a side without room and never covers the target", () => {
    // Against the right edge: "right" doesn't fit, so it goes left.
    const target = box(1300, 400, 100, 40);
    const layout = computeCalloutLayout(target, 44, desktop, ["right", "left"])!;
    expect(layout.bubble.left + layout.bubble.width).toBeLessThan(target.left);
    expect(layout.arrow!.to.x).toBe(target.left - 6);
  });

  test("on phones it docks above or below with a caret, no arrow", () => {
    const top = computeCalloutLayout(box(20, 100, 200, 40), 44, phone, ["right"])!;
    expect(top.arrow).toBeNull();
    expect(top.caret!.edge).toBe("top");
    expect(top.bubble.top).toBe(152);
    expect(top.bubble.width).toBe(366);
    const bottom = computeCalloutLayout(box(20, 800, 200, 40), 44, phone, ["right"])!;
    expect(bottom.caret!.edge).toBe("bottom");
    expect(bottom.bubble.top + 44).toBeLessThan(800);
    // A callout that prefers above docks above when it fits.
    const preferAbove = computeCalloutLayout(box(20, 400, 200, 40), 44, phone, ["left", "above"])!;
    expect(preferAbove.caret!.edge).toBe("bottom");
  });

  test("hides while the target is off screen", () => {
    expect(computeCalloutLayout(box(20, 1000, 200, 40), 44, desktop, ["below"])).toBeNull();
  });
});
