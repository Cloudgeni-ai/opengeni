import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AttemptToolContent, AttemptToolResult } from "@opengeni/contracts";

const MAX_IMAGE_BASE64_CHARS = 16 * 1024 * 1024;
const TEMP_IMAGE_PREFIX = "opengeni-codemode-image-";
const TEMP_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TEMP_IMAGE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;
type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export type CodemodeLocalImage = Readonly<{
  /** Local path readable with the agent's `view_image` tool. */
  path: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
}>;

/** Typed Code Mode calls with image blocks retain every structured and non-image block. */
export type CodemodeMultimodalValue<T> = Readonly<{
  structuredContent: T;
  images: readonly CodemodeLocalImage[];
  otherContent: readonly Exclude<AttemptToolContent, { type: "image" }>[];
}>;

/** Preserve image blocks as private local files instead of base64 in program output. */
export async function materializeCodemodeImages(
  result: AttemptToolResult,
  options: { saveTo?: string; requireOne?: boolean } = {},
): Promise<CodemodeLocalImage[]> {
  const blocks = result.content.filter((content) => content.type === "image");
  if (options.requireOne && blocks.length !== 1) {
    throw new Error("Codemode browser screenshot must return exactly one image block");
  }
  if (blocks.length === 0) return [];
  if (options.saveTo !== undefined && blocks.length !== 1) {
    throw new Error("An explicit image path requires exactly one image block");
  }

  let totalBase64Chars = 0;
  const decoded = blocks.map((block) => {
    const mimeType = supportedMimeType(block.mimeType);
    totalBase64Chars += block.data.length;
    if (
      block.data.length === 0 ||
      block.data.length > MAX_IMAGE_BASE64_CHARS ||
      totalBase64Chars > MAX_IMAGE_BASE64_CHARS
    ) {
      throw new Error("Codemode image exceeds the Code Mode result limit");
    }
    const bytes = Buffer.from(block.data, "base64");
    if (
      bytes.length === 0 ||
      bytes.toString("base64") !== block.data ||
      !matchesImageType(bytes, mimeType)
    ) {
      throw new Error("Codemode image bytes are invalid");
    }
    return { bytes, mimeType };
  });

  let directory: string | undefined;
  if (options.saveTo === undefined) {
    await pruneExpiredPrivateImages();
    directory = await mkdtemp(join(tmpdir(), TEMP_IMAGE_PREFIX));
  } else {
    if (options.saveTo.length === 0) throw new TypeError("Image saveTo must be a nonempty path");
    await mkdir(dirname(resolve(options.saveTo)), { recursive: true });
  }
  const images: CodemodeLocalImage[] = [];
  try {
    for (const [index, image] of decoded.entries()) {
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]!;
      const path =
        options.saveTo === undefined
          ? join(
              directory!,
              decoded.length === 1 ? `frame.${extension}` : `image-${index + 1}.${extension}`,
            )
          : resolve(options.saveTo);
      await writeFile(path, image.bytes, { flag: "wx", mode: 0o600 });
      images.push({ path, mimeType: image.mimeType, sizeBytes: image.bytes.length });
    }
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return images;
}

/** Opportunistic cleanup across short-lived scripts; caller-owned saveTo paths are never touched. */
async function pruneExpiredPrivateImages(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < TEMP_IMAGE_PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  if (typeof process.getuid !== "function") return;
  try {
    let removed = 0;
    for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^opengeni-codemode-image-[A-Za-z0-9]{6}$/u.test(entry.name)) {
        continue;
      }
      const path = join(tmpdir(), entry.name);
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0 ||
        now - info.mtimeMs < TEMP_IMAGE_MAX_AGE_MS
      ) {
        continue;
      }
      await rm(path, { recursive: true, force: true });
      if (++removed >= 64) break;
    }
  } catch {
    // Temp cleanup must not block a live screenshot.
  }
}

function supportedMimeType(mimeType: string): ImageMimeType {
  if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") {
    return mimeType;
  }
  throw new Error(`Codemode image has unsupported type: ${mimeType}`);
}

function matchesImageType(bytes: Buffer, mimeType: ImageMimeType): boolean {
  switch (mimeType) {
    case "image/png":
      return (
        bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      );
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      );
  }
}
