import { Buffer } from "node:buffer";
import type { Page } from "playwright";

export type ScreenshotPixelStats = {
  width: number;
  height: number;
  quantizedColorCount: number;
  luminanceStdDev: number;
  nearBlackPixelRatio: number;
  nearBlackRowRatio: number;
  worstNearBlackRowRatio: number;
  transparentPixelRatio: number;
};

export type ScreenshotIntegrityOptions = {
  minQuantizedColors?: number;
  minLuminanceStdDev?: number;
  maxNearBlackPixelRatio?: number;
  maxNearBlackRowRatio?: number;
  maxTransparentPixelRatio?: number;
};

const defaultIntegrityOptions = {
  minQuantizedColors: 16,
  minLuminanceStdDev: 4,
  maxNearBlackPixelRatio: 0.08,
  maxNearBlackRowRatio: 0.08,
  maxTransparentPixelRatio: 0.01,
} satisfies Required<ScreenshotIntegrityOptions>;

/**
 * Decode an actual Playwright PNG inside Chromium and inspect its pixels. This
 * observes the captured compositor output, unlike DOM visibility assertions.
 */
export async function inspectScreenshotPixels(
  page: Page,
  png: Uint8Array,
): Promise<ScreenshotPixelStats> {
  const base64 = Buffer.from(png).toString("base64");
  return await page.evaluate(async (encoded) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Chromium did not provide a 2D screenshot decoder");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const quantizedColors = new Set<number>();
      const pixelCount = canvas.width * canvas.height;
      let luminanceSum = 0;
      let luminanceSquareSum = 0;
      let nearBlackPixels = 0;
      let nearBlackRows = 0;
      let worstNearBlackRowRatio = 0;
      let transparentPixels = 0;

      for (let y = 0; y < canvas.height; y += 1) {
        let rowNearBlackPixels = 0;
        for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          const red = pixels[offset] ?? 0;
          const green = pixels[offset + 1] ?? 0;
          const blue = pixels[offset + 2] ?? 0;
          const alpha = pixels[offset + 3] ?? 0;
          const opaque = alpha >= 250;
          const nearBlack = opaque && red <= 2 && green <= 2 && blue <= 2;
          if (nearBlack) {
            nearBlackPixels += 1;
            rowNearBlackPixels += 1;
          }
          if (alpha < 250) transparentPixels += 1;
          const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          luminanceSum += luminance;
          luminanceSquareSum += luminance * luminance;
          quantizedColors.add((red >> 4) * 256 + (green >> 4) * 16 + (blue >> 4));
        }
        const rowRatio = canvas.width === 0 ? 1 : rowNearBlackPixels / canvas.width;
        if (rowRatio >= 0.8) nearBlackRows += 1;
        worstNearBlackRowRatio = Math.max(worstNearBlackRowRatio, rowRatio);
      }

      const mean = pixelCount === 0 ? 0 : luminanceSum / pixelCount;
      const variance =
        pixelCount === 0 ? 0 : Math.max(0, luminanceSquareSum / pixelCount - mean * mean);
      return {
        width: canvas.width,
        height: canvas.height,
        quantizedColorCount: quantizedColors.size,
        luminanceStdDev: Math.sqrt(variance),
        nearBlackPixelRatio: pixelCount === 0 ? 1 : nearBlackPixels / pixelCount,
        nearBlackRowRatio: canvas.height === 0 ? 1 : nearBlackRows / canvas.height,
        worstNearBlackRowRatio,
        transparentPixelRatio: pixelCount === 0 ? 1 : transparentPixels / pixelCount,
      };
    } finally {
      bitmap.close();
    }
  }, base64);
}

export function assertScreenshotIntegrity(
  stats: ScreenshotPixelStats,
  label: string,
  options: ScreenshotIntegrityOptions = {},
): void {
  const limits = { ...defaultIntegrityOptions, ...options };
  const failures: string[] = [];
  if (stats.width <= 0 || stats.height <= 0) failures.push("empty dimensions");
  if (stats.quantizedColorCount < limits.minQuantizedColors) {
    failures.push(`${stats.quantizedColorCount} quantized colors < ${limits.minQuantizedColors}`);
  }
  if (stats.luminanceStdDev < limits.minLuminanceStdDev) {
    failures.push(
      `luminance deviation ${stats.luminanceStdDev.toFixed(3)} < ${limits.minLuminanceStdDev}`,
    );
  }
  if (stats.nearBlackPixelRatio > limits.maxNearBlackPixelRatio) {
    failures.push(
      `near-black pixels ${formatRatio(stats.nearBlackPixelRatio)} > ${formatRatio(limits.maxNearBlackPixelRatio)}`,
    );
  }
  if (stats.nearBlackRowRatio > limits.maxNearBlackRowRatio) {
    failures.push(
      `near-black rows ${formatRatio(stats.nearBlackRowRatio)} > ${formatRatio(limits.maxNearBlackRowRatio)}`,
    );
  }
  if (stats.transparentPixelRatio > limits.maxTransparentPixelRatio) {
    failures.push(
      `transparent pixels ${formatRatio(stats.transparentPixelRatio)} > ${formatRatio(limits.maxTransparentPixelRatio)}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `${label} screenshot integrity failed: ${failures.join("; ")} (${JSON.stringify(stats)})`,
    );
  }
}

export async function assertScreenshotPainted(
  page: Page,
  png: Uint8Array,
  label: string,
  options: ScreenshotIntegrityOptions = {},
): Promise<ScreenshotPixelStats> {
  const stats = await inspectScreenshotPixels(page, png);
  assertScreenshotIntegrity(stats, label, options);
  return stats;
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
