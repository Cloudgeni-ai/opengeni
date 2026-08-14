import {
  BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES,
  BROWSER_CONTROL_MAX_JSON_BYTES,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
} from "@opengeni/contracts";
import {
  BROWSER_MEDIA_MAX_BYTES,
  assertImageDimensions,
  imageDimensions,
  type BrowserImageFrame,
} from "./media";

export {
  BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES,
  BROWSER_CONTROL_MAX_JSON_BYTES,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
};

export type BrowserFrameMetadata = Omit<BrowserImageFrame, "data">;

export function browserFrameMetadata(frame: BrowserImageFrame): BrowserFrameMetadata {
  const { data: _data, ...metadata } = frame;
  return metadata;
}

/** One websocket message: uint32-be metadata length, UTF-8 JSON metadata, image bytes. */
export function encodeBrowserFrameMessage(frame: BrowserImageFrame): Uint8Array {
  const normalized = validateBrowserImageFrame(frame);
  const metadata = Buffer.from(JSON.stringify(browserFrameMetadata(normalized)), "utf8");
  if (metadata.byteLength === 0 || metadata.byteLength > BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES) {
    throw new Error("browser frame metadata exceeds its wire envelope");
  }
  const message = new Uint8Array(4 + metadata.byteLength + frame.data.byteLength);
  new DataView(message.buffer).setUint32(0, metadata.byteLength, false);
  message.set(metadata, 4);
  message.set(frame.data, 4 + metadata.byteLength);
  return message;
}

export function decodeBrowserFrameMessage(message: Uint8Array): BrowserImageFrame {
  if (
    message.byteLength < 5 ||
    message.byteLength > 4 + BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES + BROWSER_MEDIA_MAX_BYTES
  ) {
    throw new Error("browser frame message is truncated or too large");
  }
  const metadataBytes = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  ).getUint32(0, false);
  if (
    metadataBytes < 1 ||
    metadataBytes > BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES ||
    metadataBytes + 4 >= message.byteLength
  ) {
    throw new Error("browser frame metadata length is invalid");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(Buffer.from(message.subarray(4, 4 + metadataBytes)).toString("utf8"));
  } catch {
    throw new Error("browser frame metadata is invalid JSON");
  }
  const parsed = parseBrowserFrameMetadata(metadata);
  return validateBrowserImageFrame({ ...parsed, data: message.slice(4 + metadataBytes) });
}

export function encodeBrowserFrameMetadataHeader(frame: BrowserImageFrame): string {
  return Buffer.from(
    JSON.stringify(browserFrameMetadata(validateBrowserImageFrame(frame))),
    "utf8",
  ).toString("base64url");
}

export function decodeBrowserFrameMetadataHeader(value: string): BrowserFrameMetadata {
  if (
    value.length === 0 ||
    value.length > Math.ceil((BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES * 4) / 3) + 4
  ) {
    throw new Error("browser frame metadata header is empty or too large");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("browser frame metadata header is invalid");
  }
  return parseBrowserFrameMetadata(metadata);
}

export function parseBrowserFrameMetadata(value: unknown): BrowserFrameMetadata {
  if (!isRecord(value)) throw new Error("browser frame metadata is invalid");
  const allowed = new Set([
    "frameId",
    "browserSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "documentGeneration",
    "sequence",
    "mediaType",
    "width",
    "height",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
    "capturedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("browser frame metadata contains unknown fields");
  }
  const requiredStrings = [
    "frameId",
    "browserSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "documentGeneration",
    "mediaType",
    "capturedAt",
  ] as const;
  for (const key of requiredStrings) {
    if (
      typeof value[key] !== "string" ||
      value[key].length === 0 ||
      Buffer.byteLength(value[key]) > stringBound(key)
    ) {
      throw new Error("browser frame metadata is invalid");
    }
  }
  const requiredNumbers = [
    "sequence",
    "width",
    "height",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
  ] as const;
  for (const key of requiredNumbers) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error("browser frame metadata is invalid");
    }
  }
  const parsed = {
    frameId: value.frameId as string,
    browserSessionId: value.browserSessionId as string,
    controllerGeneration: value.controllerGeneration as string,
    targetId: value.targetId as string,
    targetGeneration: value.targetGeneration as string,
    documentGeneration: value.documentGeneration as string,
    sequence: value.sequence as number,
    mediaType: value.mediaType as string,
    width: value.width as number,
    height: value.height as number,
    deviceScaleFactor: value.deviceScaleFactor as number,
    scrollX: value.scrollX as number,
    scrollY: value.scrollY as number,
    capturedAt: value.capturedAt as string,
  };
  if (
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 0 ||
    !Number.isSafeInteger(parsed.width) ||
    !Number.isSafeInteger(parsed.height)
  ) {
    throw new Error("browser frame metadata integers are invalid");
  }
  assertImageDimensions(parsed.width, parsed.height);
  if (
    parsed.deviceScaleFactor <= 0 ||
    parsed.deviceScaleFactor > 16 ||
    Math.abs(parsed.scrollX) > 1_000_000_000 ||
    Math.abs(parsed.scrollY) > 1_000_000_000
  ) {
    throw new Error("browser frame geometry metadata is invalid");
  }
  if (parsed.mediaType !== "image/jpeg" && parsed.mediaType !== "image/png") {
    throw new Error("browser frame media type is invalid");
  }
  if (!isUuid(parsed.browserSessionId)) throw new Error("browser frame session id is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(parsed.controllerGeneration)) {
    throw new Error("browser frame controller generation is invalid");
  }
  const capturedAt = new Date(parsed.capturedAt);
  if (!Number.isFinite(capturedAt.valueOf())) throw new Error("browser frame timestamp is invalid");
  return parsed as BrowserFrameMetadata;
}

function validateBrowserImageFrame(frame: BrowserImageFrame): BrowserImageFrame {
  const metadata = parseBrowserFrameMetadata(browserFrameMetadata(frame));
  if (frame.data.byteLength === 0 || frame.data.byteLength > BROWSER_MEDIA_MAX_BYTES) {
    throw new Error("browser frame image is empty or too large");
  }
  const format = metadata.mediaType === "image/png" ? "png" : "jpeg";
  const dimensions = imageDimensions(frame.data, format);
  if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) {
    throw new Error("browser frame image dimensions do not match metadata");
  }
  return { ...metadata, data: frame.data };
}

function stringBound(key: string): number {
  if (key === "targetId") return 512;
  if (key === "capturedAt") return 128;
  return 256;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
