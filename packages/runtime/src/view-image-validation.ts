import {
  COMPUTER_SCREENSHOT_MAX_BYTES,
  COMPUTER_SCREENSHOT_MAX_DIMENSION,
  COMPUTER_SCREENSHOT_MAX_PIXELS,
} from "@opengeni/contracts";

export type ViewImageMediaType = "image/png" | "image/jpeg" | "image/webp";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_ALLOWED_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const PNG_MAX_CHUNKS = 16_384;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function decodeValidatedViewImageDataUrl(value: string): {
  declaredMediaType: string;
  actualMediaType: ViewImageMediaType | null;
} | null {
  const match = /^data:([^;,]+);base64,/.exec(value);
  if (!match?.[1]) return null;
  const declaredMediaType = match[1].toLowerCase();
  const encoded = value.slice(match[0].length);
  const maxEncodedLength = Math.ceil(COMPUTER_SCREENSHOT_MAX_BYTES / 3) * 4;
  if (
    encoded.length === 0 ||
    encoded.length > maxEncodedLength ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return { declaredMediaType, actualMediaType: null };
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > COMPUTER_SCREENSHOT_MAX_BYTES) {
    return { declaredMediaType, actualMediaType: null };
  }
  const lastSextet = base64Sextet(encoded.charCodeAt(encoded.length - padding - 1));
  if (
    (padding === 2 && (lastSextet & 0x0f) !== 0) ||
    (padding === 1 && (lastSextet & 0x03) !== 0)
  ) {
    return { declaredMediaType, actualMediaType: null };
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== decodedLength) {
    return { declaredMediaType, actualMediaType: null };
  }
  const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const actualMediaType = validatedViewImageMediaType(bytes);
  return { declaredMediaType, actualMediaType };
}

function validatedViewImageMediaType(bytes: Uint8Array): ViewImageMediaType | null {
  try {
    if (isPng(bytes)) {
      validatePng(bytes);
      return "image/png";
    }
    if (isJpeg(bytes)) {
      validateJpeg(bytes);
      return "image/jpeg";
    }
    if (isWebp(bytes)) {
      validateWebp(bytes);
      return "image/webp";
    }
  } catch {
    return null;
  }
  return null;
}

function validatePng(bytes: Uint8Array): void {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength + 25) throw new Error("truncated PNG");
  let offset = PNG_SIGNATURE.byteLength;
  let chunks = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  while (offset < bytes.byteLength) {
    chunks += 1;
    if (chunks > PNG_MAX_CHUNKS || offset + 12 > bytes.byteLength) {
      throw new Error("invalid PNG chunk table");
    }
    const length = readUint32Be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const crcOffset = dataEnd;
    const nextOffset = crcOffset + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.byteLength) {
      throw new Error("truncated PNG chunk");
    }
    const type = asciiChunkType(bytes, typeOffset);
    if (readUint32Be(bytes, crcOffset) !== crc32(bytes.subarray(typeOffset, dataEnd))) {
      throw new Error("invalid PNG CRC");
    }
    if (chunks === 1 && type !== "IHDR") throw new Error("PNG must begin with IHDR");
    if (isCriticalPngChunk(type) && !PNG_ALLOWED_CRITICAL_CHUNKS.has(type)) {
      throw new Error("unsupported critical PNG chunk");
    }
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) throw new Error("invalid PNG IHDR");
      sawIhdr = true;
      assertImageDimensions(readUint32Be(bytes, dataOffset), readUint32Be(bytes, dataOffset + 4));
      if (
        !validPngColorMode(bytes[dataOffset + 8], bytes[dataOffset + 9]) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)
      ) {
        throw new Error("invalid PNG IHDR fields");
      }
    } else if (type === "IDAT") {
      if (!sawIhdr || sawIend || endedIdat || length === 0) {
        throw new Error("invalid PNG IDAT ordering");
      }
      sawIdat = true;
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }
    if (type === "IEND") {
      if (!sawIhdr || !sawIdat || sawIend || length !== 0 || nextOffset !== bytes.byteLength) {
        throw new Error("invalid PNG IEND");
      }
      sawIend = true;
    }
    offset = nextOffset;
  }
  if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.byteLength) {
    throw new Error("incomplete PNG");
  }
}

function validateJpeg(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    throw new Error("truncated JPEG");
  }
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new Error("invalid JPEG marker table");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length - 2) throw new Error("truncated JPEG segment");
    const length = readUint16Be(bytes, offset);
    if (length < 2 || offset + length > bytes.length - 2) throw new Error("invalid JPEG segment");
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) throw new Error("invalid JPEG frame");
      assertImageDimensions(readUint16Be(bytes, offset + 5), readUint16Be(bytes, offset + 3));
      sawFrame = true;
    }
    offset += length;
    if (marker !== 0xda) continue;
    sawScan = true;
    while (offset < bytes.length - 2) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let markerOffset = offset;
      while (bytes[markerOffset] === 0xff) markerOffset += 1;
      const scanMarker = bytes[markerOffset];
      if (
        scanMarker === 0x00 ||
        (scanMarker !== undefined && scanMarker >= 0xd0 && scanMarker <= 0xd7)
      ) {
        offset = markerOffset + 1;
        continue;
      }
      break;
    }
  }
  if (!sawFrame || !sawScan || offset !== bytes.length - 2) throw new Error("incomplete JPEG");
}

function validateWebp(bytes: Uint8Array): void {
  if (readUint32Le(bytes, 4) + 8 !== bytes.byteLength) throw new Error("invalid WebP RIFF length");
  let offset = 12;
  let sawFrame = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32Le(bytes, offset + 4);
    const data = offset + 8;
    const next = data + length + (length & 1);
    if (!Number.isSafeInteger(next) || next > bytes.length) throw new Error("truncated WebP chunk");
    if (type === "VP8X") {
      if (length < 10) throw new Error("invalid WebP VP8X frame");
      assertImageDimensions(1 + readUint24Le(bytes, data + 4), 1 + readUint24Le(bytes, data + 7));
    } else if (type === "VP8 ") {
      validateWebpFrameChunk(type, bytes, data, length);
      sawFrame = true;
    } else if (type === "VP8L") {
      validateWebpFrameChunk(type, bytes, data, length);
      sawFrame = true;
    } else if (type === "ANMF") {
      if (length < 24) throw new Error("invalid WebP animation frame");
      assertImageDimensions(1 + readUint24Le(bytes, data + 6), 1 + readUint24Le(bytes, data + 9));
      let frameOffset = data + 16;
      const frameEnd = data + length;
      let sawFrameImage = false;
      while (frameOffset + 8 <= frameEnd) {
        const frameType = ascii(bytes, frameOffset, 4);
        const frameLength = readUint32Le(bytes, frameOffset + 4);
        const frameData = frameOffset + 8;
        const frameNext = frameData + frameLength + (frameLength & 1);
        if (!Number.isSafeInteger(frameNext) || frameNext > frameEnd) {
          throw new Error("truncated WebP animation subchunk");
        }
        if (frameType === "VP8 " || frameType === "VP8L") {
          validateWebpFrameChunk(frameType, bytes, frameData, frameLength);
          sawFrameImage = true;
        }
        frameOffset = frameNext;
      }
      if (!sawFrameImage || frameOffset !== frameEnd) {
        throw new Error("incomplete WebP animation frame");
      }
      sawFrame = true;
    }
    offset = next;
  }
  if (!sawFrame || offset !== bytes.byteLength) throw new Error("incomplete WebP");
}

function validateWebpFrameChunk(
  type: string,
  bytes: Uint8Array,
  data: number,
  length: number,
): void {
  if (type === "VP8 ") {
    if (
      length < 10 ||
      bytes[data + 3] !== 0x9d ||
      bytes[data + 4] !== 0x01 ||
      bytes[data + 5] !== 0x2a
    ) {
      throw new Error("invalid WebP VP8 frame");
    }
    assertImageDimensions(
      readUint16Le(bytes, data + 6) & 0x3fff,
      readUint16Le(bytes, data + 8) & 0x3fff,
    );
    return;
  }
  if (length < 5 || bytes[data] !== 0x2f) throw new Error("invalid WebP VP8L frame");
  const bits = readUint32Le(bytes, data + 1);
  assertImageDimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
}

function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > COMPUTER_SCREENSHOT_MAX_DIMENSION ||
    height > COMPUTER_SCREENSHOT_MAX_DIMENSION ||
    width * height > COMPUTER_SCREENSHOT_MAX_PIXELS
  ) {
    throw new Error("image dimensions exceed policy");
  }
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= PNG_SIGNATURE.byteLength &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

function validPngColorMode(bitDepth: number | undefined, colorType: number | undefined): boolean {
  if (bitDepth === undefined || colorType === undefined) return false;
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return (
    (colorType === 2 || colorType === 4 || colorType === 6) && (bitDepth === 8 || bitDepth === 16)
  );
}

function asciiChunkType(bytes: Uint8Array, offset: number): string {
  const chars = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (
    chars.some(
      (value) => value === undefined || value < 65 || (value > 90 && value < 97) || value > 122,
    )
  ) {
    throw new Error("invalid PNG chunk type");
  }
  return String.fromCharCode(...(chars as number[]));
}

function isCriticalPngChunk(type: string): boolean {
  return type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  return code === 0x2b ? 62 : 63;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
