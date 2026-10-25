import { describe, expect, test } from "bun:test";

import { zoomShortcut } from "../src/components/zoom-pan-image";
import {
  canPan,
  fitScale,
  fitView,
  panBy,
  pinchTo,
  stepScale,
  toggleAt,
  zoomPercent,
  zoomTo,
} from "../src/lib/zoom-pan";

const viewport = { width: 1000, height: 800 };
const large = { width: 2000, height: 1500 };
const small = { width: 200, height: 100 };

describe("zoom geometry", () => {
  test("fitting shrinks large images and enlarges small ones at most 2x", () => {
    expect(fitScale(large, viewport)).toBeCloseTo(968 / 2000);
    expect(fitScale(small, viewport)).toBe(2);
    const view = fitView(small, viewport);
    // Centred, with the enlarged 400 x 200 image in the middle.
    expect(view).toEqual({ scale: 2, x: 300, y: 300, fit: true });
  });

  test("zooming keeps the point under the pointer still and pans stay within the image", () => {
    const fitted = fitView(large, viewport);
    const point = { x: 700, y: 300 };
    const imageX = (point.x - fitted.x) / fitted.scale;
    const zoomed = zoomTo(fitted, 2, point, large, viewport);
    expect(zoomed.fit).toBe(false);
    expect(zoomed.x + imageX * zoomed.scale).toBeCloseTo(point.x);
    expect(canPan(zoomed, large, viewport)).toBe(true);
    // Dragging far past an edge stops at it.
    expect(panBy(zoomed, 10_000, 10_000, large, viewport)).toMatchObject({ x: 0, y: 0 });
    expect(panBy(zoomed, -10_000, -10_000, large, viewport)).toMatchObject({
      x: 1000 - 4000,
      y: 800 - 3000,
    });
  });

  test("zoom stops include the fitted size and stay within the limits", () => {
    const fitted = fitView(large, viewport);
    expect(stepScale(fitted, 1, large, viewport)).toBe(0.5);
    const zoomedIn = zoomTo(fitted, 0.5, { x: 0, y: 0 }, large, viewport);
    expect(stepScale(zoomedIn, -1, large, viewport)).toBeCloseTo(fitted.scale);
    // Back at the fitted size, the view is fitted again.
    expect(zoomTo(zoomedIn, fitted.scale, { x: 0, y: 0 }, large, viewport).fit).toBe(true);
    expect(zoomTo(fitted, 100, { x: 0, y: 0 }, large, viewport).scale).toBe(8);
    expect(zoomTo(fitted, 0.01, { x: 0, y: 0 }, large, viewport).scale).toBeCloseTo(fitted.scale);
    // An enlarged small image can zoom out to its actual size.
    expect(zoomTo(fitView(small, viewport), 0.1, { x: 0, y: 0 }, small, viewport).scale).toBe(1);
  });

  test("a click toggles fitted and actual size, or 200% when they are the same", () => {
    const fitted = fitView(large, viewport);
    const actual = toggleAt(fitted, { x: 500, y: 400 }, large, viewport);
    expect(zoomPercent(actual)).toBe(100);
    expect(toggleAt(actual, { x: 500, y: 400 }, large, viewport)).toEqual(fitted);
    const exact = { width: 968, height: 768 };
    const exactFit = fitView(exact, viewport);
    expect(exactFit.scale).toBe(1);
    expect(zoomPercent(toggleAt(exactFit, { x: 500, y: 400 }, exact, viewport))).toBe(200);
  });

  test("a pinch keeps the pinched point between the fingers as they move apart and along", () => {
    const start = zoomTo(fitView(large, viewport), 1, { x: 500, y: 400 }, large, viewport);
    const from = { distance: 100, middle: { x: 400, y: 300 } };
    const to = { distance: 200, middle: { x: 450, y: 320 } };
    const imagePoint = {
      x: (from.middle.x - start.x) / start.scale,
      y: (from.middle.y - start.y) / start.scale,
    };
    const pinched = pinchTo(start, from, to, large, viewport);
    expect(pinched.scale).toBeCloseTo(2);
    // The image point that was under the fingers is under their new midpoint.
    expect(pinched.x + imagePoint.x * pinched.scale).toBeCloseTo(to.middle.x);
    expect(pinched.y + imagePoint.y * pinched.scale).toBeCloseTo(to.middle.y);
    // Moving both fingers without spreading them only pans.
    const moved = pinchTo(start, from, { ...from, middle: { x: 420, y: 290 } }, large, viewport);
    expect(moved).toMatchObject({ scale: start.scale, x: start.x + 20, y: start.y - 10 });
  });
});

describe("zoom shortcuts", () => {
  // Only the fields the shortcut reads.
  const key = (init: Partial<KeyboardEvent>) =>
    zoomShortcut({
      key: "",
      code: "",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...init,
    } as KeyboardEvent);

  test("Cmd or Ctrl with plus, minus and zero", () => {
    expect(key({ key: "=", metaKey: true })).toBe("in");
    expect(key({ key: "+", ctrlKey: true, shiftKey: true })).toBe("in");
    expect(key({ key: "-", ctrlKey: true })).toBe("out");
    expect(key({ key: "0", metaKey: true })).toBe("fit");
    expect(key({ key: "ß", code: "Minus", ctrlKey: true })).toBe("out");
    expect(key({ key: "=" })).toBeNull();
    expect(key({ key: "=", ctrlKey: true, altKey: true })).toBeNull();
    expect(key({ key: "k", metaKey: true })).toBeNull();
  });
});
