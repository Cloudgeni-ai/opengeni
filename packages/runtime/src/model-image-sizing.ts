import { createHash } from "node:crypto";
import sharp from "sharp";

type SizedImage = {
  data: string;
  mediaType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
};

/** A bounded, run-local cache. Image count never changes an image's projection. */
export function createModelImageSizer(maxDimension: number, maxEncodedBytes = 10 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 1) {
    throw new RangeError("Model image dimension must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes < 1) {
    throw new RangeError("Model image byte limit must be a positive integer.");
  }
  const cache = new Map<string, SizedImage>();
  let cacheBytes = 0;
  const maxCacheBytes = 32 * 1024 * 1024;
  return async (data: string, mediaType: string): Promise<SizedImage> => {
    const key = createHash("sha256").update(mediaType).update(data).digest("hex");
    const prior = cache.get(key);
    if (prior) return prior;
    try {
      if (data.length > Math.ceil((64 * 1024 * 1024) / 3) * 4) throw new Error();
      const bytes = Buffer.from(data, "base64");
      // Never admit other Sharp decoders (particularly SVG) through an image
      // MIME claim. Only the provider's four passive raster formats may enter.
      const signature = bytes.subarray(0, 12);
      const matches =
        (mediaType === "image/png" &&
          signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (mediaType === "image/jpeg" &&
          signature[0] === 255 &&
          signature[1] === 216 &&
          signature[2] === 255) ||
        (mediaType === "image/webp" &&
          signature.toString("ascii", 0, 4) === "RIFF" &&
          signature.toString("ascii", 8, 12) === "WEBP") ||
        (mediaType === "image/gif" &&
          ["GIF87a", "GIF89a"].includes(signature.toString("ascii", 0, 6)));
      if (!matches) throw new Error();
      const decoder = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" });
      const metadata = await decoder.metadata();
      if (!metadata.width || !metadata.height) throw new Error();
      let result: SizedImage = {
        data,
        mediaType,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        width: metadata.width,
        height: metadata.height,
      };
      if (
        metadata.width > maxDimension ||
        metadata.height > maxDimension ||
        data.length > maxEncodedBytes
      ) {
        const oriented = (metadata.orientation ?? 1) >= 5;
        const pipeline = decoder.autoOrient().resize({
          width: maxDimension,
          height: maxDimension,
          fit: "inside",
          withoutEnlargement: true,
        });
        // Never expand image payloads: that can break a previously valid request
        // at its total byte limit. This budget depends only on the image itself.
        const encodedBudget = Math.min(maxEncodedBytes, data.length);
        let resized = await pipeline.clone().png().toBuffer({ resolveWithObject: true });
        let outputType = "image/png";
        for (const quality of [90, 75, 60, 45, 30, 15, 1]) {
          if (Math.ceil(resized.data.length / 3) * 4 <= encodedBudget) break;
          resized = await pipeline.clone().webp({ quality }).toBuffer({ resolveWithObject: true });
          outputType = "image/webp";
        }
        if (Math.ceil(resized.data.length / 3) * 4 > encodedBudget) throw new Error();
        result = {
          ...result,
          data: resized.data.toString("base64"),
          mediaType: outputType,
          originalWidth: oriented ? metadata.height : metadata.width,
          originalHeight: oriented ? metadata.width : metadata.height,
          width: resized.info.width,
          height: resized.info.height,
        };
      }
      const size = result.data.length;
      if (size <= maxCacheBytes) {
        while (cache.size && (cacheBytes + size > maxCacheBytes || cache.size >= 256)) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)!.data.length;
          cache.delete(oldest);
        }
        cache.set(key, result);
        cacheBytes += size;
      }
      return result;
    } catch {
      throw new Error("Model image could not be decoded within the image sizing limit.");
    }
  };
}
