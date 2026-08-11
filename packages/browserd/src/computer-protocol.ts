import { createHash } from "node:crypto";
import { COMPUTER_CONTROL_WEBSOCKET_PROTOCOL } from "@opengeni/contracts";
import type { ComputerImageFrame } from "./computer-media";
import { BROWSER_MEDIA_MAX_BYTES, assertImageDimensions, imageDimensions } from "./media";
import { BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES } from "./protocol";

export { COMPUTER_CONTROL_WEBSOCKET_PROTOCOL };

export type ComputerFrameMetadata = Omit<ComputerImageFrame, "data"> & { sha256: string };

export function computerFrameMetadata(frame: ComputerImageFrame): ComputerFrameMetadata {
  const { data: _data, ...metadata } = frame;
  return {
    ...metadata,
    sha256: createHash("sha256").update(frame.data).digest("hex"),
  };
}

/** One websocket message: uint32-be metadata length, UTF-8 JSON metadata, image bytes. */
export function encodeComputerFrameMessage(frame: ComputerImageFrame): Uint8Array {
  const normalized = validateComputerImageFrame(frame);
  const header = Buffer.from(JSON.stringify(computerFrameMetadata(normalized)), "utf8");
  if (header.byteLength < 1 || header.byteLength > BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES) {
    throw new Error("computer frame metadata exceeds its wire envelope");
  }
  const output = new Uint8Array(4 + header.byteLength + normalized.data.byteLength);
  new DataView(output.buffer).setUint32(0, header.byteLength, false);
  output.set(header, 4);
  output.set(normalized.data, 4 + header.byteLength);
  return output;
}

export function decodeComputerFrameMessage(message: Uint8Array): ComputerImageFrame {
  if (
    message.byteLength < 5 ||
    message.byteLength > 4 + BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES + BROWSER_MEDIA_MAX_BYTES
  ) {
    throw new Error("computer frame message is truncated or too large");
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
    throw new Error("computer frame metadata length is invalid");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(Buffer.from(message.subarray(4, 4 + metadataBytes)).toString("utf8"));
  } catch {
    throw new Error("computer frame metadata is invalid JSON");
  }
  const parsed = parseComputerFrameMetadata(metadata);
  const data = message.slice(4 + metadataBytes);
  if (createHash("sha256").update(data).digest("hex") !== parsed.sha256) {
    throw new Error("computer frame digest does not match image");
  }
  return validateComputerImageFrame({
    ...withoutDigest(parsed),
    data,
  });
}

export function encodeComputerFrameMetadataHeader(frame: ComputerImageFrame): string {
  return Buffer.from(
    JSON.stringify(computerFrameMetadata(validateComputerImageFrame(frame))),
    "utf8",
  ).toString("base64url");
}

export function decodeComputerFrameMetadataHeader(value: string): ComputerFrameMetadata {
  if (
    value.length < 1 ||
    value.length > Math.ceil((BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES * 4) / 3) + 4
  ) {
    throw new Error("computer frame metadata header is empty or too large");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("computer frame metadata header is invalid");
  }
  return parseComputerFrameMetadata(metadata);
}

export function parseComputerFrameMetadata(value: unknown): ComputerFrameMetadata {
  if (!isRecord(value)) throw new Error("computer frame metadata is invalid");
  const allowed = new Set([
    "frameId",
    "computerSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "sequence",
    "mediaType",
    "width",
    "height",
    "capturedAt",
    "sha256",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("computer frame metadata contains unknown fields");
  }
  const requiredStrings = [
    "frameId",
    "computerSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "mediaType",
    "capturedAt",
    "sha256",
  ] as const;
  for (const key of requiredStrings) {
    if (
      typeof value[key] !== "string" ||
      value[key].length < 1 ||
      Buffer.byteLength(value[key]) > stringBound(key)
    ) {
      throw new Error("computer frame metadata is invalid");
    }
  }
  const sequence = value.sequence;
  const width = value.width;
  const height = value.height;
  if (
    !Number.isSafeInteger(sequence) ||
    Number(sequence) < 0 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height)
  ) {
    throw new Error("computer frame metadata integers are invalid");
  }
  assertImageDimensions(Number(width), Number(height));
  const mediaType = value.mediaType;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new Error("computer frame media type is invalid");
  }
  const computerSessionId = value.computerSessionId as string;
  if (!isUuid(computerSessionId)) throw new Error("computer frame session id is invalid");
  const controllerGeneration = value.controllerGeneration as string;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(controllerGeneration)) {
    throw new Error("computer frame controller generation is invalid");
  }
  const capturedAt = value.capturedAt as string;
  if (!Number.isFinite(new Date(capturedAt).valueOf())) {
    throw new Error("computer frame timestamp is invalid");
  }
  const sha256 = value.sha256 as string;
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("computer frame digest is invalid");
  return {
    frameId: value.frameId as string,
    computerSessionId,
    controllerGeneration,
    targetId: value.targetId as string,
    targetGeneration: value.targetGeneration as string,
    sequence: Number(sequence),
    mediaType,
    width: Number(width),
    height: Number(height),
    capturedAt,
    sha256,
  };
}

function validateComputerImageFrame(frame: ComputerImageFrame): ComputerImageFrame {
  const metadata = parseComputerFrameMetadata(computerFrameMetadata(frame));
  if (frame.data.byteLength < 1 || frame.data.byteLength > BROWSER_MEDIA_MAX_BYTES) {
    throw new Error("computer frame image is empty or too large");
  }
  const digest = createHash("sha256").update(frame.data).digest("hex");
  if (digest !== metadata.sha256) throw new Error("computer frame digest does not match image");
  const dimensions = imageDimensions(
    frame.data,
    metadata.mediaType === "image/png" ? "png" : "jpeg",
  );
  if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) {
    throw new Error("computer frame image dimensions do not match metadata");
  }
  return { ...withoutDigest(metadata), data: frame.data };
}

function withoutDigest(metadata: ComputerFrameMetadata): Omit<ComputerImageFrame, "data"> {
  const { sha256: _sha256, ...frame } = metadata;
  return frame;
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
