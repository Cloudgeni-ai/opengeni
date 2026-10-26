import { describe, expect, test } from "bun:test";

import { cachedLogoFit, logoFitFromPixels, measureLogoFit } from "./logo-fit";

const SIZE = 32;

/** RGBA pixels where `opaque(x, y)` decides each pixel's alpha. */
function pixels(opaque: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) data[(y * SIZE + x) * 4 + 3] = opaque(x, y) ? 255 : 0;
  return { width: SIZE, height: SIZE, data };
}

describe("logoFitFromPixels", () => {
  test("a square image with opaque edges is an app icon", () => {
    expect(
      logoFitFromPixels(
        256,
        256,
        pixels(() => true),
      ),
    ).toBe("cover");
  });

  test("an app icon with transparent rounded corners still fills the tile", () => {
    const rounded = pixels((x, y) => {
      const corner = (x < 3 || x > SIZE - 4) && (y < 3 || y > SIZE - 4);
      return !corner;
    });
    expect(logoFitFromPixels(180, 180, rounded)).toBe("cover");
  });

  test("a transparent mark with padding is padded", () => {
    const mark = pixels((x, y) => x > 6 && x < SIZE - 7 && y > 6 && y < SIZE - 7);
    expect(logoFitFromPixels(64, 64, mark)).toBe("contain");
  });

  test("a wide wordmark is never cropped, however opaque", () => {
    expect(
      logoFitFromPixels(
        300,
        80,
        pixels(() => true),
      ),
    ).toBe("contain");
    expect(
      logoFitFromPixels(
        0,
        0,
        pixels(() => true),
      ),
    ).toBe("contain");
  });
});

describe("measureLogoFit", () => {
  test("an image the canvas cannot read is a mark, and the answer is cached", () => {
    const tainted = {
      naturalWidth: 64,
      naturalHeight: 64,
      ownerDocument: {
        createElement: () => ({
          getContext: () => ({
            drawImage: () => undefined,
            getImageData: () => {
              throw new Error("SecurityError");
            },
          }),
        }),
      },
    } as unknown as HTMLImageElement;
    expect(measureLogoFit("https://cdn.example.test/logo.png", tainted)).toBe("contain");
    expect(cachedLogoFit("https://cdn.example.test/logo.png")).toBe("contain");
  });

  test("reads the drawn pixels of a loaded image", () => {
    const opaque = pixels(() => true);
    const image = {
      naturalWidth: 128,
      naturalHeight: 128,
      ownerDocument: {
        createElement: () => ({
          getContext: () => ({
            drawImage: () => undefined,
            getImageData: () => opaque,
          }),
        }),
      },
    } as unknown as HTMLImageElement;
    expect(measureLogoFit("/v1/catalog-assets/icon.png", image)).toBe("cover");
    expect(cachedLogoFit("/v1/catalog-assets/icon.png")).toBe("cover");
  });
});
