import { describe, expect, test } from "bun:test";
import { toAlpha } from "../src/lib/avatar-mask";
import { AVATAR_STYLES, avatarColors, avatarStyleId } from "../src/lib/avatar-styles";

const SIZE = 20;

/** A square picture with a filled disc in the middle. */
function picture(ground: number, shape: number) {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const inside = (x - 9.5) ** 2 + (y - 9.5) ** 2 < 25;
      const value = inside ? shape : ground;
      const offset = (y * SIZE + x) * 4;
      rgba.set([value, value, value, 255], offset);
    }
  }
  return rgba;
}

describe("toAlpha", () => {
  test("a white glyph on black becomes an opaque shape on a clear ground", () => {
    const alpha = toAlpha(picture(0, 255), SIZE)!;
    expect(alpha[10 * SIZE + 10]).toBe(255);
    expect(alpha[0]).toBe(0);
  });

  test("reads the other polarity from the border", () => {
    const alpha = toAlpha(picture(240, 30), SIZE)!;
    expect(alpha[10 * SIZE + 10]).toBe(255);
    expect(alpha[0]).toBe(0);
  });

  test("a picture with no shape gives no mask", () => {
    expect(toAlpha(picture(128, 128), SIZE)).toBeNull();
  });
});

describe("avatar styles", () => {
  test("unknown and legacy style ids fall back to the default", () => {
    expect(avatarStyleId("og-mono")).toBe("soft");
    expect(avatarStyleId("ink")).toBe("ink");
  });

  test("every style gives colors in light and dark, stable per agent", () => {
    for (const style of AVATAR_STYLES) {
      for (const dark of [false, true]) {
        const colors = avatarColors(style.id, "agent-1", dark);
        expect(colors.background).toBeTruthy();
        expect(colors.glyph).toBeTruthy();
        expect(avatarColors(style.id, "agent-1", dark)).toEqual(colors);
      }
    }
  });
});
