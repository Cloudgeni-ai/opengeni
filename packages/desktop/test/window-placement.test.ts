import { describe, expect, test } from "bun:test";

import { placeWindow } from "../src/main/window-placement";

const laptop = { x: 0, y: 32, width: 1440, height: 868 };
const big = { x: 0, y: 0, width: 2560, height: 1400 };

describe("window placement", () => {
  test("first launch opens at the default size", () => {
    expect(placeWindow({ saved: null, workAreas: [big], primary: big, platform: "linux" })).toEqual(
      {
        bounds: { width: 1280, height: 860 },
        maximize: false,
      },
    );
  });

  test("a small screen leaves a margin around the default size", () => {
    expect(
      placeWindow({ saved: null, workAreas: [laptop], primary: laptop, platform: "linux" }).bounds,
    ).toEqual({ width: 1280, height: 788 });
  });

  test("a saved maximized window reopens maximized from its normal bounds", () => {
    const saved = { x: 100, y: 100, width: 1000, height: 700, maximized: true };
    expect(placeWindow({ saved, workAreas: [big], primary: big, platform: "win32" })).toEqual({
      bounds: { x: 100, y: 100, width: 1000, height: 700 },
      maximize: true,
    });
    expect(
      placeWindow({ saved, workAreas: [big], primary: big, platform: "darwin" }).maximize,
    ).toBe(false);
  });

  test("a window saved on a display that is gone opens at the default size", () => {
    const saved = { x: 3000, y: 100, width: 1000, height: 700, maximized: true };
    expect(placeWindow({ saved, workAreas: [big], primary: big, platform: "linux" })).toEqual({
      bounds: { width: 1280, height: 860 },
      maximize: false,
    });
  });

  test("a saved window smaller than the minimum is ignored", () => {
    const saved = { x: 100, y: 100, width: 400, height: 300 };
    expect(
      placeWindow({ saved, workAreas: [big], primary: big, platform: "linux" }).bounds,
    ).toEqual({ width: 1280, height: 860 });
  });
});
