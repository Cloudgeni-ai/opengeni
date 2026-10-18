// Whether an image is a real desktop frame: decoded by Chromium (any format
// it reads), at least desktop-sized and not one flat colour. A desktop that
// never drew, or a canvas that stayed empty, fails.

export type FrameStats = { width: number; height: number; colors: number; offMain: number };

/** Decodes `bytes` in `page` (a blank page: the app's own may forbid data: URLs). */
export async function frameStats(
  page: any,
  bytes: Uint8Array,
  mediaType: string,
): Promise<FrameStats> {
  const base64 = Buffer.from(bytes).toString("base64");
  return page.evaluate(
    async ({ encoded, type }: { encoded: string; type: string }) => {
      const blob = await (await fetch(`data:${type};base64,${encoded}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      // Colours at 4 bits a channel, over at most about 200,000 pixels.
      const stride = 4 * Math.max(1, Math.floor(data.length / 4 / 200_000));
      const seen = new Map<number, number>();
      let samples = 0;
      for (let i = 0; i < data.length; i += stride) {
        const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
        seen.set(key, (seen.get(key) ?? 0) + 1);
        samples += 1;
      }
      let main = 0;
      for (const count of seen.values()) main = Math.max(main, count);
      return {
        width: bitmap.width,
        height: bitmap.height,
        colors: seen.size,
        offMain: (samples - main) / samples,
      };
    },
    { encoded: base64, type: mediaType },
  );
}

/** Why `stats` is not a real desktop frame, or null when it is. */
export function notAFrame(stats: FrameStats): string | null {
  const size = `${stats.width}x${stats.height}`;
  if (stats.width < 640 || stats.height < 400) return `a ${size} image is too small for a desktop`;
  if (stats.colors < 4 || stats.offMain < 0.005) {
    return `a blank ${size} frame (${stats.colors} colours, ${(stats.offMain * 100).toFixed(2)}% of pixels off its main colour)`;
  }
  return null;
}

export const describeFrame = (stats: FrameStats) =>
  `${stats.width}x${stats.height}, ${stats.colors} colours, ${(stats.offMain * 100).toFixed(1)}% off its main colour`;
