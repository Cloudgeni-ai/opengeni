import sharp from "sharp";

/**
 * HEIC/HEIF photos (the default camera format on iPhones) are not an image
 * format any model provider accepts, and the bundled image library cannot
 * decode HEVC. This module decodes them with libheif compiled to WebAssembly
 * and re-encodes them as a JPEG the model can see.
 *
 * Decoding is deterministic for the same bytes, so the same photo always
 * produces the same JPEG and an earlier request's image stays byte-identical.
 */

/** HEVC-coded HEIF brands (ISO/IEC 23008-12): HEIC images and sequences. */
const HEVC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
/** Generic HEIF structural brands. They also front AVIF, which is excluded. */
const STRUCTURAL_BRANDS = new Set(["mif1", "mif2", "mif3", "msf1"]);
const AV1_BRANDS = new Set(["avif", "avis"]);

export type HeifImageKind = "HEIC" | "HEIF";

// The part of libheif-js's JavaScript API (single-file build) used here.
type HeifDisplayBuffer = { data: Uint8ClampedArray; width: number; height: number };
type LibHeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  has_alpha_channel(): boolean;
  display(target: HeifDisplayBuffer, done: (result: HeifDisplayBuffer | null) => void): void;
  free(): void;
};
type LibHeifModule = {
  HeifDecoder: new () => { decode(bytes: Uint8Array): LibHeifImage[] };
};
type LibHeifFactory = () => Promise<LibHeifModule>;

/**
 * Whether these bytes are a HEIC/HEIF image, read from the leading `ftyp` box.
 * AVIF shares the container but is a different format and returns null.
 */
export function sniffHeifImage(bytes: Uint8Array): HeifImageKind | null {
  if (bytes.byteLength < 16) return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString("latin1", 4, 8) !== "ftyp") return null;
  const boxSize = view.readUInt32BE(0);
  if (boxSize < 16 || boxSize > Math.min(view.byteLength, 4096) || boxSize % 4 !== 0) return null;
  const brands = [view.toString("latin1", 8, 12)];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    brands.push(view.toString("latin1", offset, offset + 4));
  }
  if (brands.some((brand) => AV1_BRANDS.has(brand))) return null;
  if (brands.some((brand) => HEVC_BRANDS.has(brand))) return "HEIC";
  return brands.some((brand) => STRUCTURAL_BRANDS.has(brand)) ? "HEIF" : null;
}

export type HeifJpegRendition = {
  data: Buffer;
  width: number;
  height: number;
};

export type HeifJpegOptions = {
  /** JPEG quality, 1 to 100. */
  quality?: number;
  /** Largest decoded image, in pixels, that will be decoded at all. */
  maxPixels?: number;
};

export const DEFAULT_HEIF_JPEG_QUALITY = 90;
const DEFAULT_HEIF_MAX_PIXELS = 64_000_000;

export class HeifDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeifDecodeError";
  }
}

// One decode at a time per process: a 12-megapixel photo needs roughly 150 MB
// of decoder memory, and parallel attachment reads must not multiply that.
let decodeQueue: Promise<unknown> = Promise.resolve();

/**
 * Decode the primary image of a HEIC/HEIF file (with its stored rotation and
 * mirroring applied) and encode it as a JPEG. Throws {@link HeifDecodeError}
 * when the bytes are not a decodable HEIC/HEIF image.
 */
export async function heifToJpeg(
  bytes: Uint8Array,
  options: HeifJpegOptions = {},
): Promise<HeifJpegRendition> {
  const quality = options.quality ?? DEFAULT_HEIF_JPEG_QUALITY;
  if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100) {
    throw new RangeError("HEIF JPEG quality must be an integer from 1 to 100.");
  }
  const maxPixels = options.maxPixels ?? DEFAULT_HEIF_MAX_PIXELS;
  if (!sniffHeifImage(bytes)) throw new HeifDecodeError("Not a HEIC or HEIF image.");
  const run = decodeQueue.then(
    async () => await decodeToJpeg(bytes, quality, maxPixels),
    async () => await decodeToJpeg(bytes, quality, maxPixels),
  );
  decodeQueue = run.catch(() => undefined);
  return await run;
}

async function decodeToJpeg(
  bytes: Uint8Array,
  quality: number,
  maxPixels: number,
): Promise<HeifJpegRendition> {
  const { default: createLibHeif } = (await import(
    // @ts-expect-error libheif-js ships no types; LibHeifModule covers what is used.
    "libheif-js/libheif-wasm/libheif-bundle.js"
  )) as { default: LibHeifFactory };
  // A fresh module instance per image: WebAssembly memory only grows, so a
  // shared instance would keep the largest photo's decode buffers for the
  // life of the process. Instantiating takes a few milliseconds.
  const libheif = await createLibHeif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  try {
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0];
    if (!image) throw new HeifDecodeError("The HEIF file contains no decodable image.");
    const width = image.get_width();
    const height = image.get_height();
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > maxPixels
    ) {
      throw new HeifDecodeError("The HEIF image dimensions are outside the decoding limit.");
    }
    const hasAlpha = image.has_alpha_channel();
    const pixels = await new Promise<Uint8ClampedArray>((resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (result) => {
          if (result) resolve(result.data);
          else reject(new HeifDecodeError("The HEIF image could not be decoded."));
        },
      );
    });
    const raw = sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), {
      raw: { width, height, channels: 4 },
    });
    const opaque = hasAlpha ? raw.flatten({ background: "#ffffff" }) : raw.removeAlpha();
    const data = await opaque.jpeg({ quality }).toBuffer();
    return { data, width, height };
  } finally {
    // The module instance, with its context and memory, is dropped here.
    for (const image of images) image.free();
  }
}

type ViewImageArgs = { path: string; runAs?: string };
type ViewImageSession = {
  viewImage?: (args: ViewImageArgs) => Promise<unknown>;
  readFile?: (args: ViewImageArgs) => Promise<string | Uint8Array>;
};

function imageOutputBytes(output: unknown): Uint8Array | null {
  if (!output || typeof output !== "object") return null;
  const image = (output as { image?: unknown }).image;
  if (!image || typeof image !== "object") return null;
  const data = (image as { data?: unknown }).data;
  return data instanceof Uint8Array ? data : null;
}

function jpegImageOutput(jpeg: HeifJpegRendition) {
  return {
    type: "image" as const,
    image: { data: new Uint8Array(jpeg.data), mediaType: "image/jpeg" },
  };
}

/**
 * A view of a sandbox session whose `view_image` shows HEIC/HEIF photos as a
 * JPEG, the same as an attached photo, instead of rejecting them as an
 * unsupported format. Every other member is the session's own.
 */
export function withViewableHeifImages<T extends object>(session: T): T {
  const target = session as T & ViewImageSession;
  if (typeof target.viewImage !== "function") return session;
  const viewImage = async (args: ViewImageArgs): Promise<unknown> => {
    let output: unknown;
    try {
      output = await target.viewImage!(args);
    } catch (error) {
      // Providers read the bytes, find no format they know and refuse. Read
      // the file again only for that refusal, and only convert real HEIF.
      if (
        typeof target.readFile !== "function" ||
        !/unsupported image format/i.test(error instanceof Error ? error.message : String(error))
      ) {
        throw error;
      }
      let bytes: string | Uint8Array;
      try {
        bytes = await target.readFile({
          path: args.path,
          ...(args.runAs ? { runAs: args.runAs } : {}),
        });
      } catch {
        throw error;
      }
      if (typeof bytes === "string" || !sniffHeifImage(bytes)) throw error;
      try {
        return jpegImageOutput(await heifToJpeg(bytes));
      } catch {
        throw error;
      }
    }
    // A HEIC saved under an image extension is labelled by its name.
    const bytes = imageOutputBytes(output);
    if (bytes && sniffHeifImage(bytes)) return jpegImageOutput(await heifToJpeg(bytes));
    return output;
  };
  return new Proxy(target, {
    get(object, property) {
      if (property === "viewImage") return viewImage;
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
