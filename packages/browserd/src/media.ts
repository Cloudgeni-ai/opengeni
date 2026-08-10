export const BROWSER_MEDIA_MAX_BYTES = 24 * 1024 * 1024;
export const BROWSER_MEDIA_MAX_DIMENSION = 32_768;
export const BROWSER_MEDIA_MAX_PIXELS = 100_000_000;

export type BrowserImageFormat = "jpeg" | "png";

export type BrowserImageFrame = Readonly<{
  frameId: string;
  browserSessionId: string;
  controllerGeneration: string;
  targetId: string;
  targetGeneration: string;
  documentGeneration: string;
  sequence: number;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  deviceScaleFactor: number;
  scrollX: number;
  scrollY: number;
  data: Uint8Array;
  capturedAt: string;
}>;

export type BrowserScreenshotOptions = Readonly<{
  format?: BrowserImageFormat;
  quality?: number;
  fullPage?: boolean;
}>;

export type BrowserFrameStreamOptions = Readonly<{
  format?: BrowserImageFormat;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}>;

export interface BrowserFrameSubscription extends AsyncIterable<BrowserImageFrame> {
  close(): Promise<void>;
}

export type NormalizedBrowserFrameStreamOptions = Readonly<{
  format: BrowserImageFormat;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
}>;

export function normalizeFrameStreamOptions(
  options: BrowserFrameStreamOptions = {},
): NormalizedBrowserFrameStreamOptions {
  const format = options.format ?? "jpeg";
  const quality = boundedInteger(options.quality ?? 70, 1, 100, "frame quality");
  const maxWidth = boundedInteger(options.maxWidth ?? 1_440, 1, 4_096, "frame width");
  const maxHeight = boundedInteger(options.maxHeight ?? 900, 1, 4_096, "frame height");
  const everyNthFrame = boundedInteger(
    options.everyNthFrame ?? 1,
    1,
    60,
    "frame sampling interval",
  );
  return { format, quality, maxWidth, maxHeight, everyNthFrame };
}

export function normalizeScreenshotOptions(
  options: BrowserScreenshotOptions = {},
): Required<BrowserScreenshotOptions> {
  return {
    format: options.format ?? "png",
    quality: boundedInteger(options.quality ?? 90, 1, 100, "screenshot quality"),
    fullPage: options.fullPage ?? false,
  };
}

export function decodeBoundedBase64Image(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("browser media response did not contain an image");
  }
  if (value.length > Math.ceil((BROWSER_MEDIA_MAX_BYTES * 4) / 3) + 4) {
    throw new Error("browser media response exceeds its byte bound");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("browser media response contains invalid base64");
  }
  const data = Uint8Array.from(Buffer.from(value, "base64"));
  if (data.byteLength === 0 || data.byteLength > BROWSER_MEDIA_MAX_BYTES) {
    throw new Error("browser media response exceeds its byte bound");
  }
  return data;
}

export function imageDimensions(
  data: Uint8Array,
  format: BrowserImageFormat,
): { width: number; height: number } {
  const dimensions = format === "png" ? pngDimensions(data) : jpegDimensions(data);
  assertImageDimensions(dimensions.width, dimensions.height);
  return dimensions;
}

export function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > BROWSER_MEDIA_MAX_DIMENSION ||
    height > BROWSER_MEDIA_MAX_DIMENSION ||
    width * height > BROWSER_MEDIA_MAX_PIXELS
  ) {
    throw new Error("browser image dimensions exceed their bounded envelope");
  }
}

/** Bounded latest-wins fan-out cursor shared by Browser and Computer media.
 * Slow viewers skip superseded frames instead of accumulating stale input. */
export class LatestFrameSubscription<TFrame> implements AsyncIterable<TFrame> {
  private latest: TFrame | null = null;
  private waiter: {
    resolve: (value: IteratorResult<TFrame>) => void;
    reject: (reason?: unknown) => void;
  } | null = null;
  private ended = false;
  private failure: Error | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly onClose: () => Promise<void>) {}

  [Symbol.asyncIterator](): AsyncIterator<TFrame> {
    return this;
  }

  next(): Promise<IteratorResult<TFrame>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.latest) {
      const frame = this.latest;
      this.latest = null;
      return Promise.resolve({ done: false, value: frame });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    if (this.waiter) {
      return Promise.reject(new Error("browser frame subscription already has a pending read"));
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  push(frame: TFrame): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ done: false, value: frame });
      return;
    }
    this.latest = frame;
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    this.latest = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.ended = true;
    this.latest = null;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve({ done: true, value: undefined });
    this.closePromise = this.onClose();
    return this.closePromise;
  }

  return(): Promise<IteratorResult<TFrame>> {
    return this.close().then(() => ({ done: true, value: undefined }));
  }
}

export class LatestBrowserFrameSubscription
  extends LatestFrameSubscription<BrowserImageFrame>
  implements BrowserFrameSubscription {}

function pngDimensions(data: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    data.byteLength < 24 ||
    !signature.every((byte, index) => data[index] === byte) ||
    String.fromCharCode(...data.slice(12, 16)) !== "IHDR"
  ) {
    throw new Error("browser returned an invalid PNG image");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error("browser returned an invalid JPEG image");
  }
  let offset = 2;
  while (offset + 3 < data.byteLength) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = data[offset + 1]!;
    while (marker === 0xff) {
      offset += 1;
      marker = data[offset + 1]!;
    }
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= data.byteLength) break;
    const length = (data[offset + 2]! << 8) | data[offset + 3]!;
    if (length < 2 || offset + 2 + length > data.byteLength) break;
    if (isStartOfFrame(marker)) {
      if (length < 7) break;
      return {
        height: (data[offset + 5]! << 8) | data[offset + 6]!,
        width: (data[offset + 7]! << 8) | data[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  throw new Error("browser returned a JPEG without dimensions");
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`browser ${label} must be a bounded integer`);
  }
  return value;
}
