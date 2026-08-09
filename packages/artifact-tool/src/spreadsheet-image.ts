import {
  boundedUtf8ByteLength,
  canonicalizeRasterDataUrl,
  encodeRasterBase64,
  normalizeRasterContentType,
  RasterImageValidationError,
  validateRasterImageBytes,
} from "./raster-image";
import type { SpreadsheetImageConfig } from "./spreadsheet-types";

export type SpreadsheetRasterImageContentType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/** Untrusted spreadsheet image input was rejected before render or file export. */
export class InvalidSpreadsheetImageError extends Error {
  readonly code = "INVALID_SPREADSHEET_IMAGE";

  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`Invalid spreadsheet ${field}: ${detail}`);
    this.name = "InvalidSpreadsheetImageError";
  }
}

// Keep these model-boundary caps aligned with SPREADSHEET_SNAPSHOT_LIMITS.
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ALT_LENGTH = 1024 * 1024;
const MAX_PIXEL_VALUE = 1_000_000;
const normalizedImages = new WeakSet<object>();

/**
 * Copies, validates, and freezes a spreadsheet image at the model boundary.
 *
 * Both byte and data-URL inputs become a canonical immutable data URL. This
 * prevents later caller mutation and lets render/export reuse validation in O(1).
 */
export function normalizeSpreadsheetImageConfig(
  input: SpreadsheetImageConfig,
): SpreadsheetImageConfig {
  if (typeof input !== "object" || input === null) {
    throw new InvalidSpreadsheetImageError("image", "must be an object");
  }
  if (normalizedImages.has(input)) return input;

  const hasDataUrl = input.dataUrl !== undefined;
  const hasBlob = input.blob !== undefined;
  if (Number(hasDataUrl) + Number(hasBlob) !== 1) {
    throw new InvalidSpreadsheetImageError(
      "image source",
      "requires exactly one source: dataUrl or blob",
    );
  }

  let canonical: string;
  let contentType: SpreadsheetRasterImageContentType;
  if (hasDataUrl) {
    const parsed = parseRasterDataUrl(input.dataUrl);
    contentType = parsed.contentType;
    canonical = parsed.canonical;
  } else {
    const bytes = copyImageBytes(input.blob);
    contentType = validateRasterBytes(bytes, input.contentType, "image blob");
    canonical = `data:${contentType};base64,${encodeRasterBase64(bytes)}`;
  }

  if (input.contentType !== undefined && normalizeRasterMime(input.contentType) !== contentType) {
    throw new InvalidSpreadsheetImageError("image contentType", "does not match the image bytes");
  }

  const anchor = normalizeAnchor(input.anchor);
  const alt = normalizeAlt(input.alt);
  const normalized = Object.freeze({
    dataUrl: canonical,
    contentType,
    ...(alt === undefined ? {} : { alt }),
    anchor,
  }) satisfies SpreadsheetImageConfig;
  normalizedImages.add(normalized);
  return normalized;
}

/** Returns a validated inline source and never fetches or reads external data. */
export function spreadsheetImageSource(input: SpreadsheetImageConfig): string {
  const normalized = normalizeSpreadsheetImageConfig(input);
  return normalized.dataUrl!;
}

function normalizeAnchor(
  anchor: SpreadsheetImageConfig["anchor"],
): SpreadsheetImageConfig["anchor"] {
  if (typeof anchor !== "object" || anchor === null) {
    throw new InvalidSpreadsheetImageError("image anchor", "must be an object");
  }
  const from = anchor.from;
  const extent = anchor.extent;
  if (typeof from !== "object" || from === null) {
    throw new InvalidSpreadsheetImageError("image anchor.from", "must be an object");
  }
  if (typeof extent !== "object" || extent === null) {
    throw new InvalidSpreadsheetImageError("image anchor.extent", "must be an object");
  }
  assertInteger(from.row, "image anchor.from.row", 0, 1_048_575);
  assertInteger(from.col, "image anchor.from.col", 0, 16_383);
  if (from.rowOffsetPx !== undefined) {
    assertFiniteInRange(from.rowOffsetPx, "image anchor.from.rowOffsetPx", 0, MAX_PIXEL_VALUE);
  }
  if (from.colOffsetPx !== undefined) {
    assertFiniteInRange(from.colOffsetPx, "image anchor.from.colOffsetPx", 0, MAX_PIXEL_VALUE);
  }
  assertFiniteInRange(
    extent.widthPx,
    "image anchor.extent.widthPx",
    Number.MIN_VALUE,
    MAX_PIXEL_VALUE,
  );
  assertFiniteInRange(
    extent.heightPx,
    "image anchor.extent.heightPx",
    Number.MIN_VALUE,
    MAX_PIXEL_VALUE,
  );
  return Object.freeze({
    from: Object.freeze({
      row: from.row,
      col: from.col,
      ...(from.rowOffsetPx === undefined ? {} : { rowOffsetPx: from.rowOffsetPx }),
      ...(from.colOffsetPx === undefined ? {} : { colOffsetPx: from.colOffsetPx }),
    }),
    extent: Object.freeze({ widthPx: extent.widthPx, heightPx: extent.heightPx }),
  });
}

function normalizeAlt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > MAX_ALT_LENGTH ||
    boundedUtf8ByteLength(value, MAX_ALT_LENGTH) > MAX_ALT_LENGTH
  ) {
    throw new InvalidSpreadsheetImageError("image alt", "must be a bounded string");
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new InvalidSpreadsheetImageError(
        "image alt",
        "contains characters forbidden by XML 1.0",
      );
    }
  }
  return value;
}

function parseRasterDataUrl(value: unknown): {
  contentType: SpreadsheetRasterImageContentType;
  canonical: string;
} {
  try {
    const result = canonicalizeRasterDataUrl(value, MAX_IMAGE_BYTES);
    return {
      contentType: result.contentType,
      canonical: result.canonical,
    };
  } catch (error) {
    if (error instanceof RasterImageValidationError) {
      throw new InvalidSpreadsheetImageError("image dataUrl", error.detail);
    }
    throw error;
  }
}

function copyImageBytes(value: unknown): Uint8Array {
  if (!(value instanceof ArrayBuffer)) {
    throw new InvalidSpreadsheetImageError("image blob", "must be an ArrayBuffer");
  }
  const bytes = new Uint8Array(value.slice(0));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new InvalidSpreadsheetImageError(
      "image blob",
      `must contain between 1 and ${MAX_IMAGE_BYTES} bytes`,
    );
  }
  return bytes;
}

function normalizeRasterMime(value: unknown): SpreadsheetRasterImageContentType {
  try {
    return normalizeRasterContentType(value);
  } catch (error) {
    if (error instanceof RasterImageValidationError) {
      throw new InvalidSpreadsheetImageError("image contentType", error.detail);
    }
    throw error;
  }
}

function validateRasterBytes(
  bytes: Uint8Array,
  declaredType: unknown,
  field: string,
): SpreadsheetRasterImageContentType {
  try {
    return validateRasterImageBytes(bytes, declaredType);
  } catch (error) {
    if (error instanceof RasterImageValidationError) {
      throw new InvalidSpreadsheetImageError(field, error.detail);
    }
    throw error;
  }
}

function assertInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new InvalidSpreadsheetImageError(field, `must be an integer from ${min} through ${max}`);
  }
}

function assertFiniteInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new InvalidSpreadsheetImageError(field, `must be a finite number from ${min} to ${max}`);
  }
}
