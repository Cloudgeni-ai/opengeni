/**
 * Turns a browser recording bundle into an MP4 and an action log.
 *
 * A bundle is "OGREC1\n", one JSON header line, then the JPEG frames back to
 * back (see packages/browserd/src/recording.ts). Frames exist only where the
 * page changed, so each is held on screen until the next one: ffmpeg encodes
 * the distinct frames with their real timing (variable frame rate), and the
 * cost follows how much the page changed rather than how long it ran.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAGIC = "OGREC1\n";
/** How long the final frame stays on screen when nothing followed it. */
const MIN_LAST_FRAME_MS = 1_000;
const ENCODE_TIMEOUT_MS = 5 * 60_000;

export class BrowserRecordingVideoError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_bundle" | "no_frames" | "encode_failed",
  ) {
    super(message);
    this.name = "BrowserRecordingVideoError";
  }
}

type BundleFrame = { t: number; offset: number; length: number; targetId: string };
type BundleHeader = {
  version: 1;
  recordingId: string;
  startedAt: string;
  durationMs: number;
  frames: BundleFrame[];
  actions: unknown[];
};

export type BrowserRecordingVideo = {
  video: Uint8Array;
  /** JSON action log for editing: when the agent did what, and when the page changed. */
  actionLog: Uint8Array;
  durationMs: number;
  frameCount: number;
  width: number;
  height: number;
};

export function parseBrowserRecordingBundle(bundle: Uint8Array): {
  header: BundleHeader;
  frames: Uint8Array[];
} {
  const bytes = Buffer.from(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  if (bytes.subarray(0, MAGIC.length).toString() !== MAGIC) {
    throw new BrowserRecordingVideoError("not a browser recording bundle", "invalid_bundle");
  }
  const headerEnd = bytes.indexOf(0x0a, MAGIC.length);
  if (headerEnd < 0) {
    throw new BrowserRecordingVideoError("browser recording header is truncated", "invalid_bundle");
  }
  let header: BundleHeader;
  try {
    header = JSON.parse(bytes.subarray(MAGIC.length, headerEnd).toString()) as BundleHeader;
  } catch {
    throw new BrowserRecordingVideoError("browser recording header is invalid", "invalid_bundle");
  }
  if (header.version !== 1 || !Array.isArray(header.frames) || !Array.isArray(header.actions)) {
    throw new BrowserRecordingVideoError("browser recording header is invalid", "invalid_bundle");
  }
  const body = bytes.subarray(headerEnd + 1);
  const frames = header.frames.map((frame) => {
    if (
      !Number.isSafeInteger(frame.offset) ||
      !Number.isSafeInteger(frame.length) ||
      frame.offset < 0 ||
      frame.length <= 0 ||
      frame.offset + frame.length > body.byteLength
    ) {
      throw new BrowserRecordingVideoError(
        "browser recording frame is out of range",
        "invalid_bundle",
      );
    }
    return body.subarray(frame.offset, frame.offset + frame.length);
  });
  return { header, frames };
}

/** Width and height from a baseline or progressive JPEG's frame header. */
export function jpegSize(data: Uint8Array): { width: number; height: number } {
  let offset = 2;
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    throw new BrowserRecordingVideoError("browser recording frame is not a JPEG", "invalid_bundle");
  }
  while (offset + 9 < data.byteLength) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = (data[offset + 2]! << 8) | data[offset + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (data[offset + 5]! << 8) | data[offset + 6]!,
        width: (data[offset + 7]! << 8) | data[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  throw new BrowserRecordingVideoError("browser recording frame has no size", "invalid_bundle");
}

const even = (value: number) => Math.max(2, value + (value % 2));

export async function encodeBrowserRecording(input: {
  bundle: Uint8Array;
  ffmpegPath: string;
  signal?: AbortSignal;
}): Promise<BrowserRecordingVideo> {
  const { header, frames } = parseBrowserRecordingBundle(input.bundle);
  if (frames.length === 0) {
    throw new BrowserRecordingVideoError(
      "the recording captured no frames; the page may not have been visible",
      "no_frames",
    );
  }
  const first = jpegSize(frames[0]!);
  const width = even(first.width);
  const height = even(first.height);
  const lastFrameAt = header.frames.at(-1)!.t;
  const durationMs = Math.max(header.durationMs, lastFrameAt + MIN_LAST_FRAME_MS);
  const directory = await mkdtemp(join(tmpdir(), "opengeni-browser-recording-"));
  try {
    const list: string[] = ["ffconcat version 1.0"];
    for (const [index, frame] of frames.entries()) {
      const name = `f${String(index).padStart(6, "0")}.jpg`;
      await writeFile(join(directory, name), frame);
      const start = index === 0 ? 0 : header.frames[index]!.t;
      const end = header.frames[index + 1]?.t ?? durationMs;
      list.push(`file ${name}`, `duration ${(Math.max(1, end - start) / 1_000).toFixed(3)}`);
    }
    // The concat demuxer applies the last duration only when the file repeats.
    list.push(`file f${String(frames.length - 1).padStart(6, "0")}.jpg`);
    await writeFile(join(directory, "frames.ffconcat"), `${list.join("\n")}\n`);
    const output = join(directory, "recording.mp4");
    const process = Bun.spawn(
      [
        input.ffmpegPath,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(directory, "frames.ffconcat"),
        // Frames from a tab of another size are fitted, not stretched.
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p`,
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "stillimage",
        "-crf",
        "26",
        "-movflags",
        "+faststart",
        output,
      ],
      { cwd: directory, stdout: "ignore", stderr: "pipe" },
    );
    const abort = () => process.kill();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, ENCODE_TIMEOUT_MS);
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]).finally(() => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    });
    if (exitCode !== 0) {
      throw new BrowserRecordingVideoError(
        `the recording could not be encoded: ${stderr.trim().slice(0, 500) || `ffmpeg exited ${exitCode}`}`,
        "encode_failed",
      );
    }
    const video = new Uint8Array(await readFile(output));
    const actionLog = new TextEncoder().encode(
      `${JSON.stringify(
        {
          recordingId: header.recordingId,
          startedAt: header.startedAt,
          durationMs,
          note: "Times are milliseconds from the start of the video.",
          actions: header.actions,
          pageChanges: header.frames.map((frame) => frame.t),
        },
        null,
        2,
      )}\n`,
    );
    return { video, actionLog, durationMs, frameCount: frames.length, width, height };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
