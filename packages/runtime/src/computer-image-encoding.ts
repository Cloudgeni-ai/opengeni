import sharp from "sharp";

/** Desktop captures arrive as lossless PNG, typically three to four times the
 * bytes of an equivalent JPEG. They are re-encoded once, before the model or
 * screenshot retention sees them, so every later replay of the same result
 * carries these exact bytes. Full 4:4:4 chroma keeps small coloured UI text
 * legible; pixel dimensions never change, so coordinates stay exact. */
export const COMPUTER_IMAGE_JPEG_QUALITY = 85;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_INPUT_PIXELS = 64_000_000;

type ImageContent = { type: "image"; data: string; mimeType: string };

/** JPEG bytes for one PNG desktop capture, or the PNG itself when it is not a
 * valid PNG or JPEG would not be smaller (for example a tiny flat image). */
export async function compactComputerImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (mimeType !== "image/png" || !PNG_SIGNATURE.equals(Buffer.from(bytes.subarray(0, 8)))) {
    return { data: bytes, mimeType };
  }
  let jpeg: Buffer;
  try {
    jpeg = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .jpeg({ quality: COMPUTER_IMAGE_JPEG_QUALITY, chromaSubsampling: "4:4:4" })
      .toBuffer();
  } catch {
    return { data: bytes, mimeType };
  }
  return jpeg.byteLength < bytes.byteLength
    ? {
        data: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
        mimeType: "image/jpeg",
      }
    : { data: bytes, mimeType };
}

/** The same encoding for every base64 image item of a tool result. */
export async function compactComputerImageContent<T extends { type: string }>(
  content: readonly T[],
): Promise<T[]> {
  return await Promise.all(
    content.map(async (item) => {
      if (!isImageContent(item)) return item;
      const bytes = Buffer.from(item.data, "base64");
      const compacted = await compactComputerImage(bytes, item.mimeType);
      if (compacted.data === bytes) return item;
      return {
        ...item,
        data: Buffer.from(compacted.data).toString("base64"),
        mimeType: compacted.mimeType,
      };
    }),
  );
}

function isImageContent(item: { type: string }): item is ImageContent & typeof item {
  const candidate = item as Partial<ImageContent>;
  return (
    item.type === "image" &&
    typeof candidate.data === "string" &&
    typeof candidate.mimeType === "string"
  );
}
