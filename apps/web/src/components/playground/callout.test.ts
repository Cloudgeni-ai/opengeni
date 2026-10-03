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
    expect(right.arrow!.to).toEqual({ x: target.right, y: 420 });
    expect(right.arrow!.from.x).toBe(right.bubble.left - 2);

    const below = computeCalloutLayout(target, 44, desktop, ["below"])!;
    expect(below.arrow!.to).toEqual({ x: 200, y: target.bottom });
    expect(below.bubble.top).toBe(target.bottom + 40);

    const above = computeCalloutLayout(target, 44, desktop, ["above"])!;
    expect(above.arrow!.to).toEqual({ x: 200, y: target.top });
    expect(above.bubble.top + 44).toBeLessThan(target.top);
  });

  test("skips a side without room and never covers the target", () => {
    // Against the right edge: "right" doesn't fit, so it goes left.
    const target = box(1300, 400, 100, 40);
    const layout = computeCalloutLayout(target, 44, desktop, ["right", "left"])!;
    expect(layout.bubble.left + layout.bubble.width).toBeLessThan(target.left);
    expect(layout.arrow!.to.x).toBe(target.left);
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

  test("at desktop sizes every arrow ends inside or on the edge of its target", () => {
    const sides = [
      ["right"],
      ["left"],
      ["below"],
      ["above"],
      ["right", "below"],
      ["left", "above"],
    ] as const;
    // The playground's real targets at 1440x900, and a spread of other boxes.
    const targets = [
      box(202, 82, 28, 28), // the selected color swatch
      box(84, 846, 392, 30), // the suggested questions
      box(857, 267, 498, 60), // the marked snippet lines
      box(856, 416, 197, 36), // Add it to your product
    ];
    for (let left = 40; left < 1400; left += 170)
      for (let top = 60; top < 860; top += 130) targets.push(box(left, top, 60 + (left % 90), 24));
    let arrows = 0;
    for (const viewport of [desktop, { width: 1280, height: 800 }, { width: 1920, height: 1080 }])
      for (const target of targets)
        for (const order of sides) {
          const layout = computeCalloutLayout(target, 52, viewport, order);
          if (!layout?.arrow) continue;
          arrows += 1;
          const { x, y } = layout.arrow.to;
          expect(x).toBeGreaterThanOrEqual(target.left);
          expect(x).toBeLessThanOrEqual(target.right);
          expect(y).toBeGreaterThanOrEqual(target.top);
          expect(y).toBeLessThanOrEqual(target.bottom);
          // ...and the bubble never covers its target.
          const bubble = layout.bubble;
          const overlaps =
            bubble.left < target.right &&
            bubble.left + bubble.width > target.left &&
            bubble.top < target.bottom &&
            bubble.top + 52 > target.top;
          expect(overlaps).toBe(false);
        }
    expect(arrows).toBeGreaterThan(200);
  });
});
