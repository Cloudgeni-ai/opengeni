/*
 * How a logo image should sit in its tile, decided from the image itself.
 *
 * Connector logos arrive in two shapes: square app icons that carry their own
 * background (most registry logos, many MCP server icons) and transparent
 * marks (glyphs, favicons, wordmarks). An app icon should fill the tile; a
 * mark needs padding on a plate. Rendering every logo one way is what makes a
 * catalog look inconsistent, and no source records which shape it sent, so
 * each image is measured once after it loads: a roughly square image whose
 * four edge midpoints are opaque is an icon ("cover"); anything else is a mark
 * ("contain"). An image the browser will not let us read (a cross-origin
 * asset without CORS) is treated as a mark, which is always legible.
 * Framework-neutral, so every surface (app, embedded connect, native web)
 * shares one decision and one cache.
 */

export type LogoFit = "cover" | "contain";

const SAMPLE = 32;
const OPAQUE_ALPHA = 250;
const SQUARE_TOLERANCE = 0.1;
const CACHE_LIMIT = 2_000;

const fits = new Map<string, LogoFit>();

/** The fit measured earlier for this exact `src`, if any. */
export function cachedLogoFit(src: string): LogoFit | undefined {
  return fits.get(src);
}

function remember(src: string, fit: LogoFit): LogoFit {
  if (fits.size >= CACHE_LIMIT) {
    const oldest = fits.keys().next().value;
    if (oldest !== undefined) fits.delete(oldest);
  }
  fits.set(src, fit);
  return fit;
}

/** The pixels the decision reads: RGBA of a `SAMPLE`×`SAMPLE` scaled copy. */
export type LogoPixels = { width: number; height: number; data: ArrayLike<number> };

/**
 * "cover" for a near-square image whose four edge midpoints are opaque,
 * otherwise "contain". `naturalWidth`/`naturalHeight` are the image's own
 * size; `pixels` is the image drawn into a square sample.
 */
export function logoFitFromPixels(
  naturalWidth: number,
  naturalHeight: number,
  pixels: LogoPixels,
): LogoFit {
  if (!(naturalWidth > 0 && naturalHeight > 0)) return "contain";
  const ratio = naturalWidth / naturalHeight;
  if (Math.abs(ratio - 1) > SQUARE_TOLERANCE) return "contain";
  const { width, height, data } = pixels;
  const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3] ?? 0;
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  const edges: Array<[number, number]> = [
    [midX, 0],
    [midX, height - 1],
    [0, midY],
    [width - 1, midY],
  ];
  return edges.every(([x, y]) => alpha(x, y) >= OPAQUE_ALPHA) ? "cover" : "contain";
}

/**
 * Measures a loaded image and caches the result under `src`. Never throws:
 * an unreadable image (tainted canvas, no 2D context) is a mark.
 */
export function measureLogoFit(src: string, image: HTMLImageElement): LogoFit {
  const known = fits.get(src);
  if (known) return known;
  try {
    const canvas = image.ownerDocument.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return remember(src, "contain");
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const pixels = context.getImageData(0, 0, SAMPLE, SAMPLE);
    return remember(src, logoFitFromPixels(image.naturalWidth, image.naturalHeight, pixels));
  } catch {
    return remember(src, "contain");
  }
}
