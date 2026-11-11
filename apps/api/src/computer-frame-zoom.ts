import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ComputerAction, InteractionRect } from "@opengeni/contracts";
import type { ComputerControlFrame, ComputerControlFrameMetadata } from "@opengeni/runtime/sandbox";
import { ApiHttpError } from "./http/api-error";

/**
 * Zoomed computer frames: one rectangle of a window or screen at up to its
 * full captured resolution.
 *
 * A model normally sees a window scaled down to fit 1024x768 (640x480 when
 * that image is too large), which leaves small controls unreadable. A zoom
 * names a rectangle in the pixels of the screenshot it was measured on; the
 * API captures the target once at native resolution, scales the rectangle
 * from that screenshot's size to the native one, crops it and returns it as
 * its own frame.
 *
 * The zoomed frame is a pointer frame like any other: its ID carries the crop
 * from the native capture it was cut from (`<native frame ID>:zoom.x.y.w.h.W.H`,
 * native pixels and output size), so a pointer action on it is translated
 * back into that native frame's pixels before the controller sees it. The
 * controller then fences the native frame exactly as it fences any frame:
 * stale, resized or unknown frames are refused. A forged ID gains nothing:
 * it can only name a point inside a frame the controller already knows.
 */

/** The regular model screenshot: a zoom rectangle is in its pixels unless the
 *  caller names the size of the screenshot it measured on. */
export const REGULAR_COMPUTER_FRAME_BOUNDS = { maxWidth: 1_024, maxHeight: 768 } as const;
/** Larger images are downscaled by model providers anyway (Claude: 1568
 *  long edge and about 1.15 megapixels), so a zoom never sends more. */
const ZOOM_MAX_LONG_EDGE = 1_568;
const ZOOM_MAX_PIXELS = 1_150_000;
const ZOOM_JPEG_QUALITIES = [85, 70, 55] as const;
const NATIVE_CAPTURE_MAX = 4_096;
const MAX_INPUT_PIXELS = NATIVE_CAPTURE_MAX * NATIVE_CAPTURE_MAX;
const ZOOM_FRAME_ID = /^(.+):zoom\.(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)$/u;
const OPAQUE_FRAME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
/** How far the measured screenshot's shape may differ from the native capture
 *  (rounding of either side) before it is treated as another window size. */
const SHAPE_TOLERANCE_PIXELS = 2;

export type ZoomedFrameMapping = {
  baseFrameId: string;
  /** The crop, in the native frame's pixels. */
  crop: { x: number; y: number; width: number; height: number };
  /** The zoomed frame's own pixel size. */
  output: { width: number; height: number };
};

type CaptureClient = {
  capture(
    targetId: string,
    options: {
      format?: "jpeg" | "png";
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
    },
  ): Promise<ComputerControlFrame>;
};

export type ComputerFrameSize = { width: number; height: number };

/** The zoomed frame, the rectangle it shows and the screenshot that rectangle
 *  is measured in. */
export type ZoomedComputerFrame = Pick<ComputerControlFrame, "data" | "mediaType"> & {
  metadata: ComputerControlFrameMetadata & {
    region: InteractionRect;
    regionFrame: ComputerFrameSize;
  };
  metadataHeader: string;
};

function invalidRegion(message: string): ApiHttpError {
  return new ApiHttpError(422, {
    code: "validation_failed",
    message,
    retryable: false,
    outcomeUnknown: false,
  });
}

/** `x,y,width,height` from a screenshot query, or null when absent. */
export function parseComputerFrameRegionQuery(value: string | undefined): InteractionRect | null {
  if (value === undefined) return null;
  const parts = value.split(",");
  const numbers = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))) {
    throw invalidRegion("region must be x,y,width,height in screenshot pixels");
  }
  const [x, y, width, height] = numbers as [number, number, number, number];
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw invalidRegion("region needs a non-negative x and y and a positive width and height");
  }
  return { x, y, width, height };
}

/** `width,height` of the screenshot a region was measured on, or null. */
export function parseComputerFrameSizeQuery(value: string | undefined): ComputerFrameSize | null {
  if (value === undefined) return null;
  const parts = value.split(",");
  const numbers = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (
    numbers.length !== 2 ||
    numbers.some((number) => !Number.isSafeInteger(number) || number < 1 || number > 16_384)
  ) {
    throw invalidRegion("regionFrame must be width,height of a screenshot in pixels");
  }
  const [width, height] = numbers as [number, number];
  return { width, height };
}

/** The size of the regular model screenshot of a capture this large. */
export function regularComputerFrameSize(native: ComputerFrameSize): ComputerFrameSize {
  const scale = Math.min(
    1,
    REGULAR_COMPUTER_FRAME_BOUNDS.maxWidth / native.width,
    REGULAR_COMPUTER_FRAME_BOUNDS.maxHeight / native.height,
  );
  return {
    width: Math.max(1, Math.round(native.width * scale)),
    height: Math.max(1, Math.round(native.height * scale)),
  };
}

export function zoomedFrameId(mapping: ZoomedFrameMapping): string {
  const { crop, output } = mapping;
  const id = `${mapping.baseFrameId}:zoom.${[
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    output.width,
    output.height,
  ].join(".")}`;
  if (id.length > 256 || !OPAQUE_FRAME_ID.test(id)) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "This computer cannot zoom its screenshots.",
      retryable: false,
      outcomeUnknown: false,
    });
  }
  return id;
}

/** The mapping a zoomed frame ID carries, or null for any other frame ID. */
export function decodeZoomedFrameId(frameId: string): ZoomedFrameMapping | null {
  const match = ZOOM_FRAME_ID.exec(frameId);
  if (!match) return null;
  const [x, y, width, height, outputWidth, outputHeight] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    [x, y, width, height, outputWidth, outputHeight].some(
      (value) => !Number.isSafeInteger(value),
    ) ||
    width < 1 ||
    height < 1 ||
    outputWidth < 1 ||
    outputHeight < 1
  ) {
    return null;
  }
  return {
    baseFrameId: match[1]!,
    crop: { x, y, width, height },
    output: { width: outputWidth, height: outputHeight },
  };
}

/**
 * The same action in the native frame a zoomed frame was cut from. Actions
 * that name no zoomed frame are returned unchanged.
 */
export function translateZoomedComputerAction<
  T extends { expectedFrameId?: string | null; action: unknown },
>(request: T): T {
  const action = request.action as ComputerAction;
  const expected =
    typeof request.expectedFrameId === "string"
      ? decodeZoomedFrameId(request.expectedFrameId)
      : null;
  if (!action || typeof action !== "object" || action.type !== "pointer") {
    return expected ? { ...request, expectedFrameId: expected.baseFrameId } : request;
  }
  const mapping = decodeZoomedFrameId(action.frameId);
  if (!mapping) {
    return expected ? { ...request, expectedFrameId: expected.baseFrameId } : request;
  }
  const { crop, output } = mapping;
  const point = (x: number, y: number, label: string) => {
    if (x < 0 || y < 0 || x >= output.width || y >= output.height) {
      throw new ApiHttpError(422, {
        code: "validation_failed",
        message: `The ${label} is outside the ${output.width}x${output.height} zoomed screenshot.`,
        retryable: false,
        outcomeUnknown: false,
      });
    }
    return {
      x: crop.x + (x * crop.width) / output.width,
      y: crop.y + (y * crop.height) / output.height,
    };
  };
  const start = point(action.x, action.y, "pointer position");
  const end =
    action.endX !== undefined && action.endY !== undefined
      ? point(action.endX, action.endY, "drag end")
      : null;
  return {
    ...request,
    expectedFrameId: expected ? expected.baseFrameId : request.expectedFrameId,
    action: {
      ...action,
      frameId: mapping.baseFrameId,
      x: start.x,
      y: start.y,
      ...(end ? { endX: end.x, endY: end.y } : {}),
    },
  };
}

function outputSize(width: number, height: number, factor = 1): { width: number; height: number } {
  const scale =
    Math.min(
      1,
      ZOOM_MAX_LONG_EDGE / Math.max(width, height),
      Math.sqrt(ZOOM_MAX_PIXELS / (width * height)),
    ) * factor;
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * Capture `region` of a screenshot of the target at up to native resolution.
 * `regionFrame` is the size of the screenshot the rectangle was measured on
 * (null: the regular screenshot this capture would give). One native capture
 * gives the pixels and the frame pointer actions resolve to.
 */
export async function captureZoomedComputerFrame(
  client: CaptureClient,
  targetId: string,
  region: InteractionRect,
  regionFrame: ComputerFrameSize | null,
  maxBytes: number,
  validate: (frame: ComputerControlFrame) => ComputerControlFrame,
): Promise<ZoomedComputerFrame> {
  const native = validate(
    await client.capture(targetId, {
      format: "png",
      quality: 100,
      maxWidth: NATIVE_CAPTURE_MAX,
      maxHeight: NATIVE_CAPTURE_MAX,
    }),
  );
  const nativeSize = { width: native.metadata.width, height: native.metadata.height };
  const space = regionFrame ?? regularComputerFrameSize(nativeSize);
  // The measured screenshot must show this capture: scaled to the native
  // width, its height may differ only by rounding. Otherwise the window was
  // resized since, and the rectangle would land somewhere else.
  const expectedHeight = (space.height * nativeSize.width) / space.width;
  const tolerance = SHAPE_TOLERANCE_PIXELS * Math.max(1, nativeSize.width / space.width);
  if (Math.abs(expectedHeight - nativeSize.height) > tolerance) {
    throw new ApiHttpError(409, {
      code: "conflict",
      message: `The window is no longer the shape of the ${space.width}x${space.height} screenshot this region was measured on. Observe it again, then zoom.`,
      retryable: true,
      outcomeUnknown: false,
    });
  }
  const regularWidth = space.width;
  const regularHeight = space.height;
  const left = Math.min(region.x, regularWidth);
  const top = Math.min(region.y, regularHeight);
  const right = Math.min(region.x + region.width, regularWidth);
  const bottom = Math.min(region.y + region.height, regularHeight);
  if (right - left < 1 || bottom - top < 1) {
    throw invalidRegion(
      `region is outside the ${regularWidth}x${regularHeight} screenshot of this target.`,
    );
  }
  const scaleX = native.metadata.width / regularWidth;
  const scaleY = native.metadata.height / regularHeight;
  const crop = {
    x: Math.floor(left * scaleX),
    y: Math.floor(top * scaleY),
    width: 0,
    height: 0,
  };
  crop.width = Math.max(1, Math.min(native.metadata.width, Math.ceil(right * scaleX)) - crop.x);
  crop.height = Math.max(1, Math.min(native.metadata.height, Math.ceil(bottom * scaleY)) - crop.y);
  // Decode the native image once; each size or quality attempt below only
  // resizes and encodes the cropped pixels.
  const cropped = await sharp(native.data, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  })
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = {
    width: cropped.info.width,
    height: cropped.info.height,
    channels: cropped.info.channels,
  };
  let encoded: { data: Buffer; width: number; height: number } | null = null;
  for (const factor of [1, 0.75, 0.5]) {
    const size = outputSize(crop.width, crop.height, factor);
    for (const quality of ZOOM_JPEG_QUALITIES) {
      const result = await sharp(cropped.data, { raw })
        .resize(size.width, size.height, { fit: "fill" })
        .jpeg({ quality, chromaSubsampling: "4:4:4" })
        .toBuffer({ resolveWithObject: true });
      if (result.data.byteLength <= maxBytes) {
        encoded = { data: result.data, width: result.info.width, height: result.info.height };
        break;
      }
    }
    if (encoded) break;
  }
  if (!encoded) {
    throw new ApiHttpError(422, {
      code: "limit_exceeded",
      message: "This zoomed screenshot stays too large for the model. Zoom into a smaller region.",
      retryable: false,
      outcomeUnknown: false,
    });
  }
  const data = new Uint8Array(encoded.data);
  const metadata = {
    ...native.metadata,
    frameId: zoomedFrameId({
      baseFrameId: native.metadata.frameId,
      crop,
      output: { width: encoded.width, height: encoded.height },
    }),
    mediaType: "image/jpeg" as const,
    width: encoded.width,
    height: encoded.height,
    sha256: createHash("sha256").update(data).digest("hex"),
    region: { x: left, y: top, width: right - left, height: bottom - top },
    regionFrame: { width: regularWidth, height: regularHeight },
  };
  return {
    data,
    mediaType: "image/jpeg",
    metadata,
    metadataHeader: Buffer.from(JSON.stringify(metadata)).toString("base64url"),
  };
}
