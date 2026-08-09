export type RasterImageContentType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type RasterImageMetadata = {
  contentType: RasterImageContentType;
  width: number;
  height: number;
};

/** Internal validation failure. Public model boundaries translate this to their typed error. */
export class RasterImageValidationError extends Error {
  readonly name = "RasterImageValidationError";

  get detail(): string {
    return this.message;
  }
}

/** Decode already-syntax-checked base64 without forcing a large intermediary string when supported. */
export function decodeRasterBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const native = (
    Uint8Array as typeof Uint8Array & {
      fromBase64?: (value: string) => Uint8Array<ArrayBuffer>;
    }
  ).fromBase64;
  if (native) return native(encoded);

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Encode bytes using the zero-copy native primitive where available, with a bounded fallback. */
export function encodeRasterBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);

  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const RASTER_CONTENT_TYPES = new Set<RasterImageContentType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Normalize one supported raster MIME without admitting active image formats. */
export function normalizeRasterContentType(value: unknown): RasterImageContentType {
  if (typeof value !== "string") throw invalid("content type must be a string");
  const normalized = value.toLowerCase();
  if (!RASTER_CONTENT_TYPES.has(normalized as RasterImageContentType)) {
    throw invalid("content type must be image/png, image/jpeg, image/gif, or image/webp");
  }
  return normalized as RasterImageContentType;
}

/** Validate bytes and, when supplied, bind the declared MIME to their signature. */
export function validateRasterImageBytes(
  bytes: Uint8Array,
  declaredType?: unknown,
): RasterImageContentType {
  const detected = inspectRasterImage(bytes).contentType;
  if (declaredType !== undefined && normalizeRasterContentType(declaredType) !== detected) {
    throw invalid("content type does not match the image bytes");
  }
  return detected;
}

/** Strictly decode and canonicalize an inline raster source under a byte cap. */
export function canonicalizeRasterDataUrl(
  value: unknown,
  maximumBytes: number,
): Readonly<{
  contentType: RasterImageContentType;
  canonical: string;
  byteLength: number;
}> {
  if (typeof value !== "string" || value.length > Math.ceil((maximumBytes * 4) / 3) + 128) {
    throw invalid("data URL must be a bounded string");
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) throw invalid("data URL must contain inline base64 raster bytes");
  const declaredType = normalizeRasterContentType(match[1]!);
  const encoded = match[2]!;
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw invalid("data URL contains malformed base64");
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeRasterBase64(encoded);
  } catch {
    throw invalid("data URL contains malformed base64");
  }
  if (bytes.byteLength > maximumBytes) {
    throw invalid(`decoded image exceeds ${maximumBytes} bytes`);
  }
  const contentType = validateRasterImageBytes(bytes, declaredType);
  return Object.freeze({
    contentType,
    canonical: `data:${contentType};base64,${encodeRasterBase64(bytes)}`,
    byteLength: bytes.byteLength,
  });
}

/** Count UTF-8 bytes without allocating an encoded copy; returns as soon as the cap is crossed. */
export function boundedUtf8ByteLength(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

const MAX_RASTER_DIMENSION = 16_384;
const MAX_RASTER_PIXELS = 16_777_216;
const MAX_ANIMATION_FRAMES = 500;
const MAX_ANIMATION_DECODED_PIXELS = 67_108_864;

/**
 * Structurally validates supported raster bytes before a native/browser decoder sees them.
 *
 * Callers must separately bound the encoded byte length. This parser bounds decoded canvas,
 * animation frame count, and cumulative animated pixels while walking each container once.
 */
export function inspectRasterImage(bytes: Uint8Array): RasterImageMetadata {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return parsePngHeader(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return parseJpegHeader(bytes);
  }
  if (bytes.length >= 6) {
    const signature = ascii(bytes, 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") return parseGifHeader(bytes);
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return parseWebpHeader(bytes);
  }
  throw invalid("does not have a supported PNG, JPEG, GIF, or WebP signature");
}

function parsePngHeader(bytes: Uint8Array): RasterImageMetadata {
  if (bytes.length < 45 || readU32Be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    throw malformed("PNG has no complete leading IHDR chunk");
  }
  const width = readU32Be(bytes, 16);
  const height = readU32Be(bytes, 20);
  assertRasterDimensions(width, height);

  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const allowedDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !allowedDepths[colorType]?.includes(bitDepth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  ) {
    throw malformed("PNG IHDR fields are invalid");
  }
  if (pngCrc32(bytes, 12, 29) !== readU32Be(bytes, 29)) {
    throw malformed("PNG IHDR checksum is invalid");
  }

  let offset = 33;
  let sawIdat = false;
  let declaredFrames: number | undefined;
  let frameCount = 0;
  let animationPixels = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw malformed("PNG chunk is truncated");
    const length = readU32Be(bytes, offset);
    if (length > bytes.length - offset - 12) {
      throw malformed("PNG chunk length exceeds the input");
    }
    const chunkType = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(chunkType)) {
      throw malformed("PNG chunk type is invalid");
    }
    if (chunkType === "IHDR") throw malformed("PNG contains duplicate IHDR");
    if (chunkType === "IDAT") sawIdat = true;
    if (chunkType === "acTL") {
      if (length !== 8 || declaredFrames !== undefined) {
        throw malformed("APNG animation control is invalid");
      }
      declaredFrames = readU32Be(bytes, offset + 8);
      if (declaredFrames === 0 || declaredFrames > MAX_ANIMATION_FRAMES) {
        throw invalid(`animation frame limit exceeded (maximum ${MAX_ANIMATION_FRAMES})`);
      }
    }
    if (chunkType === "fcTL") {
      if (length !== 26 || declaredFrames === undefined) {
        throw malformed("APNG frame control is invalid");
      }
      const frameWidth = readU32Be(bytes, offset + 12);
      const frameHeight = readU32Be(bytes, offset + 16);
      const frameX = readU32Be(bytes, offset + 20);
      const frameY = readU32Be(bytes, offset + 24);
      assertRasterDimensions(frameWidth, frameHeight);
      if (frameX + frameWidth > width || frameY + frameHeight > height) {
        throw malformed("APNG frame exceeds its canvas dimensions");
      }
      frameCount += 1;
      animationPixels = addAnimationPixels(animationPixels, frameWidth, frameHeight, frameCount);
    }
    const next = offset + 12 + length;
    if (chunkType === "IEND") {
      if (
        length !== 0 ||
        !sawIdat ||
        next !== bytes.length ||
        (declaredFrames !== undefined && frameCount !== declaredFrames)
      ) {
        throw malformed("PNG terminal chunks are invalid");
      }
      return { contentType: "image/png", width, height };
    }
    offset = next;
  }
  throw malformed("PNG has no terminal IEND chunk");
}

function parseJpegHeader(bytes: Uint8Array): RasterImageMetadata {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw malformed("JPEG framing is incomplete");
  }
  let offset = 2;
  let dimensions: RasterImageMetadata | undefined;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw malformed("JPEG marker prefix is invalid");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw malformed("JPEG marker is truncated");
    const marker = bytes[offset++]!;
    if (marker === 0x00) throw malformed("JPEG contains an escaped marker in headers");
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) throw malformed("JPEG ended before image data");
    if (offset + 2 > bytes.length) throw malformed("JPEG segment is truncated");
    const length = readU16Be(bytes, offset);
    if (length < 2 || length > bytes.length - offset) {
      throw malformed("JPEG segment length exceeds the input");
    }
    if (marker === 0xda) {
      if (!dimensions) {
        throw malformed("JPEG has no supported frame header before image data");
      }
      const scanComponents = bytes[offset + 2];
      if (
        scanComponents === undefined ||
        scanComponents === 0 ||
        scanComponents > 4 ||
        length !== 6 + 2 * scanComponents
      ) {
        throw malformed("JPEG scan header is invalid");
      }
      return dimensions;
    }
    if (isJpegStartOfFrame(marker)) {
      if (dimensions) throw malformed("JPEG contains duplicate frame headers");
      if (length < 8) throw malformed("JPEG frame header is too short");
      const height = readU16Be(bytes, offset + 3);
      const width = readU16Be(bytes, offset + 5);
      const components = bytes[offset + 7]!;
      if (components === 0 || components > 4 || length !== 8 + 3 * components) {
        throw malformed("JPEG frame component table is invalid");
      }
      assertRasterDimensions(width, height);
      dimensions = { contentType: "image/jpeg", width, height };
    }
    offset += length;
  }
  throw malformed("JPEG has no complete scan data");
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseGifHeader(bytes: Uint8Array): RasterImageMetadata {
  if (bytes.length < 14) throw malformed("GIF logical screen descriptor is truncated");
  const width = readU16Le(bytes, 6);
  const height = readU16Le(bytes, 8);
  assertRasterDimensions(width, height);
  const packed = bytes[10]!;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    const tableBytes = 3 * 2 ** ((packed & 0x07) + 1);
    if (tableBytes > bytes.length - offset) {
      throw malformed("GIF global color table is truncated");
    }
    offset += tableBytes;
  }
  let sawImage = false;
  let frameCount = 0;
  let animationPixels = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) {
      if (!sawImage || offset !== bytes.length) {
        throw malformed("GIF trailer or image data is invalid");
      }
      return { contentType: "image/gif", width, height };
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) throw malformed("GIF extension is truncated");
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) {
      throw malformed("GIF block structure is invalid");
    }
    const frameLeft = readU16Le(bytes, offset);
    const frameTop = readU16Le(bytes, offset + 2);
    const frameWidth = readU16Le(bytes, offset + 4);
    const frameHeight = readU16Le(bytes, offset + 6);
    assertRasterDimensions(frameWidth, frameHeight);
    if (frameLeft + frameWidth > width || frameTop + frameHeight > height) {
      throw malformed("GIF frame exceeds its canvas dimensions");
    }
    const framePacked = bytes[offset + 8]!;
    offset += 9;
    if ((framePacked & 0x80) !== 0) {
      const tableBytes = 3 * 2 ** ((framePacked & 0x07) + 1);
      if (tableBytes > bytes.length - offset) {
        throw malformed("GIF local color table is truncated");
      }
      offset += tableBytes;
    }
    if (offset >= bytes.length) {
      throw malformed("GIF LZW header is missing");
    }
    const minimumCodeSize = bytes[offset++]!;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) {
      throw malformed("GIF LZW header is invalid");
    }
    offset = skipGifSubBlocks(bytes, offset);
    frameCount += 1;
    animationPixels = addAnimationPixels(animationPixels, frameWidth, frameHeight, frameCount);
    sawImage = true;
  }
  throw malformed("GIF has no trailer");
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    if (length > bytes.length - offset) {
      throw malformed("GIF data sub-block is truncated");
    }
    offset += length;
  }
  throw malformed("GIF data sub-block has no terminator");
}

function parseWebpHeader(bytes: Uint8Array): RasterImageMetadata {
  if (bytes.length < 30 || readU32Le(bytes, 4) + 8 !== bytes.length) {
    throw malformed("WebP RIFF container length is invalid");
  }
  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  let extended = false;
  let sawImage = false;
  let frameCount = 0;
  let animationPixels = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw malformed("WebP chunk is truncated");
    const type = ascii(bytes, offset, 4);
    const length = readU32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (length > bytes.length - dataOffset) {
      throw malformed("WebP chunk length exceeds the input");
    }
    if (type === "VP8X") {
      if (offset !== 12 || dimensions || length !== 10) {
        throw malformed("WebP VP8X header placement or length is invalid");
      }
      dimensions = {
        width: readU24Le(bytes, dataOffset + 4) + 1,
        height: readU24Le(bytes, dataOffset + 7) + 1,
      };
      assertRasterDimensions(dimensions.width, dimensions.height);
      extended = true;
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        throw malformed("WebP VP8 frame header is invalid");
      }
      const frame = {
        width: readU16Le(bytes, dataOffset + 6) & 0x3fff,
        height: readU16Le(bytes, dataOffset + 8) & 0x3fff,
      };
      assertRasterDimensions(frame.width, frame.height);
      if (dimensions && (frame.width > dimensions.width || frame.height > dimensions.height)) {
        throw malformed("WebP frame exceeds its canvas dimensions");
      }
      dimensions ??= frame;
      frameCount += 1;
      animationPixels = addAnimationPixels(animationPixels, frame.width, frame.height, frameCount);
      sawImage = true;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataOffset] !== 0x2f) {
        throw malformed("WebP VP8L frame header is invalid");
      }
      const b1 = bytes[dataOffset + 1]!;
      const b2 = bytes[dataOffset + 2]!;
      const b3 = bytes[dataOffset + 3]!;
      const b4 = bytes[dataOffset + 4]!;
      const frame = {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
      assertRasterDimensions(frame.width, frame.height);
      if (dimensions && (frame.width > dimensions.width || frame.height > dimensions.height)) {
        throw malformed("WebP frame exceeds its canvas dimensions");
      }
      dimensions ??= frame;
      frameCount += 1;
      animationPixels = addAnimationPixels(animationPixels, frame.width, frame.height, frameCount);
      sawImage = true;
    } else if (type === "ANMF") {
      if (!extended || !dimensions || length < 24) {
        throw malformed("WebP animation frame header is invalid");
      }
      const frameX = readU24Le(bytes, dataOffset) * 2;
      const frameY = readU24Le(bytes, dataOffset + 3) * 2;
      const frameWidth = readU24Le(bytes, dataOffset + 6) + 1;
      const frameHeight = readU24Le(bytes, dataOffset + 9) + 1;
      assertRasterDimensions(frameWidth, frameHeight);
      if (frameX + frameWidth > dimensions.width || frameY + frameHeight > dimensions.height) {
        throw malformed("WebP animation frame exceeds its canvas dimensions");
      }
      frameCount += 1;
      animationPixels = addAnimationPixels(animationPixels, frameWidth, frameHeight, frameCount);
      sawImage = true;
    }
    const paddedLength = length + (length & 1);
    if (paddedLength > bytes.length - dataOffset) {
      throw malformed("WebP chunk padding is truncated");
    }
    offset = dataOffset + paddedLength;
  }
  if (offset !== bytes.length || !dimensions || !sawImage) {
    throw malformed("WebP has no complete image payload");
  }
  return { contentType: "image/webp", ...dimensions };
}

function assertRasterDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw invalid("image dimensions must be positive integers");
  }
  if (width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION) {
    throw invalid(
      `image dimension limit exceeded (${width}x${height}; maximum ${MAX_RASTER_DIMENSION})`,
    );
  }
  if (width > Math.floor(MAX_RASTER_PIXELS / height)) {
    throw invalid(
      `decoded pixel limit exceeded (${width}x${height}; maximum ${MAX_RASTER_PIXELS})`,
    );
  }
}

function addAnimationPixels(
  current: number,
  width: number,
  height: number,
  frames: number,
): number {
  if (frames > MAX_ANIMATION_FRAMES) {
    throw invalid(`animation frame limit exceeded (maximum ${MAX_ANIMATION_FRAMES})`);
  }
  const framePixels = width * height;
  if (current > MAX_ANIMATION_DECODED_PIXELS - framePixels) {
    throw invalid(
      `animation decoded pixel limit exceeded (maximum ${MAX_ANIMATION_DECODED_PIXELS})`,
    );
  }
  return current + framePixels;
}

function malformed(detail: string): RasterImageValidationError {
  return invalid(`malformed raster image: ${detail}`);
}

function invalid(detail: string): RasterImageValidationError {
  return new RasterImageValidationError(detail);
}

function readU16Be(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100;
}

function readU24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x1_0000;
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1_000000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x1_0000 +
    bytes[offset + 3]! * 0x1_000000
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
