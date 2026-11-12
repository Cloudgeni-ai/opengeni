import { expect, test } from "bun:test";
import { composerFieldSize } from "../src/timeline/composer-field-size";

// The stacked iPhone composer (12 Nov 2026) stayed one line tall while typing:
// earlier lines scrolled out of view. It must grow to at least four lines.
const stacked = { line: 22, padding: 16, minHeight: 40 };

test("with text the field sizes itself, up to six lines on a phone", () => {
  const size = composerFieldSize({ ...stacked, hasText: true, windowHeight: 844 });
  expect(size.height).toBeUndefined();
  expect(size.maxHeight).toBe(16 + 6 * 22);
  expect(size.minHeight).toBe(40);
});

test("four lines before it scrolls with large text on a small screen", () => {
  const large = composerFieldSize({
    ...stacked,
    line: Math.ceil(22 * 2.4),
    hasText: true,
    windowHeight: 667,
  });
  expect(large.maxHeight).toBe(16 + 4 * Math.ceil(22 * 2.4));
  // Room for five lines in a quarter of the screen: five.
  expect(
    composerFieldSize({ ...stacked, line: 30, hasText: true, windowHeight: 700 }).maxHeight,
  ).toBe(16 + 5 * 30);
});

test("with little room above the keyboard it takes at most half of it", () => {
  // A landscape phone with large text: four lines wouldn't fit beside the keyboard.
  const landscape = composerFieldSize({
    ...stacked,
    line: 33,
    hasText: true,
    windowHeight: 390,
    keyboardHeight: 200,
  });
  expect(landscape.maxHeight).toBe(16 + 2 * 33);
  // A portrait phone with the keyboard up keeps all six.
  expect(
    composerFieldSize({ ...stacked, hasText: true, windowHeight: 844, keyboardHeight: 336 })
      .maxHeight,
  ).toBe(16 + 6 * 22);
});

test("an empty field is pinned to one line", () => {
  expect(composerFieldSize({ ...stacked, hasText: false, windowHeight: 844 }).height).toBe(40);
  expect(
    composerFieldSize({ line: 22, padding: 14, minHeight: 36, hasText: false, windowHeight: 844 })
      .height,
  ).toBe(36);
  expect(
    composerFieldSize({ ...stacked, line: 44, hasText: false, windowHeight: 844 }).height,
  ).toBe(60);
});
