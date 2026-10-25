import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ComputerAction, InteractionRect } from "@opengeni/contracts";
import type { ComputerControlFrame, ComputerControlFrameMetadata } from "@opengeni/runtime/sandbox";
import { ApiHttpError } from "./http/api-error";

/**
 * Zoomed computer frames: one rectangle of a window or screen at up to its
 * full captured resolution.
 *
 * A model normally sees a window scaled down to fit 1024x768, which leaves
 * small controls unreadable. A zoom names a rectangle in the pixels of that
 * regular screenshot; the API captures the target at native resolution, crops
 * that rectangle and returns it as its own frame.
 *
 * The zoomed frame is a pointer frame like any other: its ID carries the crop
 * from the native capture it was cut from (`<native frame ID>:zoom.x.y.w.h.W.H`,
 * native pixels and output size), so a pointer action on it is translated
 * back into that native frame's pixels before the controller sees it. The
 * controller then fences the native frame exactly as it fences any frame:
 * stale, resized or unknown frames are refused. A forged ID gains nothing:
 * it can only name a point inside a frame the controller already knows.
 */

/** The regular model screenshot; a zoom rectangle is in its pixels. */
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

/** The zoomed frame and the rectangle of the regular screenshot it shows. */
export type ZoomedComputerFrame = Pick<ComputerControlFrame, "data" | "mediaType"> & {
  metadata: ComputerControlFrameMetadata & { region: InteractionRect };
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
 * Capture `region` of the target's regular screenshot at up to native
 * resolution. The regular capture gives the rectangle's coordinate space; the
 * native capture gives the pixels and the frame pointer actions resolve to.
 */
export async function captureZoomedComputerFrame(
  client: CaptureClient,
  targetId: string,
  region: InteractionRect,
  maxBytes: number,
  validate: (frame: ComputerControlFrame) => ComputerControlFrame,
): Promise<ZoomedComputerFrame> {
  const regular = validate(
    await client.capture(targetId, {
      format: "jpeg",
      quality: 30,
      ...REGULAR_COMPUTER_FRAME_BOUNDS,
    }),
  );
  const native = validate(
    await client.capture(targetId, {
      format: "png",
      quality: 100,
      maxWidth: NATIVE_CAPTURE_MAX,
      maxHeight: NATIVE_CAPTURE_MAX,
    }),
  );
  if (regular.metadata.targetGeneration !== native.metadata.targetGeneration) {
    throw new ApiHttpError(409, {
      code: "conflict",
      message: "The window changed while it was being zoomed. Observe it again.",
      retryable: true,
      outcomeUnknown: false,
    });
  }
  const regularWidth = regular.metadata.width;
  const regularHeight = regular.metadata.height;
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
  let encoded: { data: Buffer; width: number; height: number } | null = null;
  for (const factor of [1, 0.75, 0.5]) {
    const size = outputSize(crop.width, crop.height, factor);
    for (const quality of ZOOM_JPEG_QUALITIES) {
      const result = await sharp(native.data, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "error",
      })
        .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
        .resize(size.width, size.height, { fit: "fill" })
        .flatten({ background: "#ffffff" })
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
  };
  return {
    data,
    mediaType: "image/jpeg",
    metadata,
    metadataHeader: Buffer.from(JSON.stringify(metadata)).toString("base64url"),
  };
}
