/**
 * Turns a generated glyph picture (a light shape on a dark ground, or the
 * other way round) into an alpha mask, so the app can fill it with any color.
 * Masks are computed once per image and kept for the session.
 */
const SIZE = 192;
const masks = new Map<string, Promise<string | null>>();
const ready = new Map<string, string | null>();

export function avatarMask(src: string): Promise<string | null> {
  let mask = masks.get(src);
  if (!mask) {
    mask = buildMask(src).then(
      (url) => {
        ready.set(src, url);
        return url;
      },
      () => {
        // A failed download may succeed later; a picture with no shape will not.
        masks.delete(src);
        return null;
      },
    );
    masks.set(src, mask);
  }
  return mask;
}

/** The mask if it is already built, so a remount never flashes the placeholder. */
export function readyMask(src: string): string | null | undefined {
  return ready.get(src);
}

async function buildMask(src: string): Promise<string | null> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SIZE, SIZE);
  const pixels = context.getImageData(0, 0, SIZE, SIZE);
  const alpha = toAlpha(pixels.data, SIZE);
  if (!alpha) return null;
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * 4;
    pixels.data[offset] = 255;
    pixels.data[offset + 1] = 255;
    pixels.data[offset + 2] = 255;
    pixels.data[offset + 3] = alpha[index]!;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Luminance becomes coverage. The border decides polarity (the ground is
 * whatever touches the edges), and levels stretch the ground to transparent
 * and the strongest strokes to opaque, so soft or off-white renders still
 * give a crisp glyph. Returns null for a picture with no shape in it.
 */
export function toAlpha(rgba: Uint8ClampedArray, size: number): Uint8Array | null {
  const count = size * size;
  const light = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    light[index] =
      (0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!) / 255;
  }
  let border = 0;
  let borderCount = 0;
  const edge = Math.max(1, Math.round(size * 0.04));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (x >= edge && x < size - edge && y >= edge && y < size - edge) continue;
      border += light[y * size + x]!;
      borderCount += 1;
    }
  }
  const ground = border / borderCount;
  const lightGlyph = ground < 0.5;
  const ink = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    ink[index] = lightGlyph ? light[index]! - ground : ground - light[index]!;
  }
  const sorted = Float32Array.from(ink).sort();
  const strong = sorted[Math.floor(count * 0.98)]!;
  if (strong < 0.15) return null;
  const low = strong * 0.18;
  const high = strong * 0.8;
  const alpha = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = (ink[index]! - low) / (high - low);
    alpha[index] = Math.round(255 * Math.min(1, Math.max(0, value)));
  }
  return alpha;
}
